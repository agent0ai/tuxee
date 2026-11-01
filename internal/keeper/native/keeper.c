#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Protocol 2 is independent of application releases. All integers are big endian.
 * Header: magic, operation, payload length, errno, argument, auxiliary (32 bytes).
 * A reply has operation|0x80000000. No unsolicited control messages. */
enum { MAGIC = 0x54584b32, HEADER = 32, PAYLOAD = 65536, SLOTS = 32, JOBS = 8,
       RELAYS = 128, WATCHES = 64, CAPACITY = 4*1024*1024, DIRECTORY = 3 };
enum { HELLO, GET, PUT, SPAWN, STATUS, SIGNAL, RELAY, READ, COMMIT, INPUT,
       EVENT, PTY, CLOSE, TRACK, ACCEPT };
enum { OUTPUT = 1, END = 2, RESIZE = 3 };
struct job { pid_t pid; unsigned exited, status; };
struct stream { int fd; unsigned start, end; int eof; char data[4096]; };
struct relay { struct stream side[2]; };
static struct job jobs[JOBS];
static int slots[SLOTS], master = -1, notification, client = -1, master_ended;
static unsigned owners[SLOTS], references, armed;
static int watches[WATCHES];
static int pending[SLOTS];
static unsigned listening[SLOTS];
static struct relay *relays[RELAYS];
static unsigned char *journal;
static uint64_t head, tail, replied;
static unsigned input_start, input_end;
static char input[PAYLOAD];

static uint32_t get32(const void *p) { uint32_t n; memcpy(&n,p,4); return ntohl(n); }
static void put32(void *p, uint32_t n) { n=htonl(n); memcpy(p,&n,4); }
static uint64_t get64(const unsigned char *p) { return ((uint64_t)get32(p)<<32)|get32(p+4); }
static void put64(unsigned char *p, uint64_t n) { put32(p,(uint32_t)(n>>32)); put32(p+4,(uint32_t)n); }
static void fail(const char *what) {
    unsigned error=(unsigned)errno;
    char digits[12], *end=digits+sizeof(digits), *start=end;
    do { *--start=(char)('0'+error%10); error/=10; } while (error);
    struct iovec parts[]={{(void *)what,strlen(what)},{": errno ",8},{start,(size_t)(end-start)},{"\n",1}};
    ssize_t ignored=writev(2,parts,4); (void)ignored;
    _exit(1);
}
static void changed(void) { uint64_t n=1; ssize_t ignored=write(notification,&n,8); (void)ignored; }
static int nonblock(int fd) { int flags=fcntl(fd,F_GETFL); return flags<0 ? -1 : fcntl(fd,F_SETFL,flags|O_NONBLOCK); }

static int packet(int fd, unsigned op, unsigned error, uint64_t arg, uint64_t aux,
                  const void *data, unsigned length, const int *rights, unsigned count) {
    unsigned char h[HEADER]={0};
    put32(h,MAGIC); put32(h+4,op|0x80000000u); put32(h+8,length); put32(h+12,error);
    put64(h+16,arg); put64(h+24,aux);
    struct iovec iov[]={{h,HEADER},{(void *)data,length}};
    union { struct cmsghdr align; char bytes[CMSG_SPACE(4*sizeof(int))]; } control={0};
    struct msghdr msg={.msg_iov=iov,.msg_iovlen=length?2:1};
    if (count) {
        msg.msg_control=control.bytes; msg.msg_controllen=(socklen_t)CMSG_SPACE(count*sizeof(int));
        struct cmsghdr *c=CMSG_FIRSTHDR(&msg);
        c->cmsg_level=SOL_SOCKET; c->cmsg_type=SCM_RIGHTS; c->cmsg_len=(socklen_t)CMSG_LEN(count*sizeof(int));
        memcpy(CMSG_DATA(c),rights,count*sizeof(int));
    }
    return sendmsg(fd,&msg,MSG_NOSIGNAL)==(ssize_t)(HEADER+length)?0:-1;
}

static void ringcopy(uint64_t offset, void *data, unsigned length, int writing) {
    if (!length) return;
    unsigned pos=(unsigned)(offset%CAPACITY), first=CAPACITY-pos;
    if (first>length) first=length;
    if (writing) { memcpy(journal+pos,data,first); memcpy(journal,(char *)data+first,length-first); }
    else { memcpy(data,journal+pos,first); memcpy((char *)data+first,journal,length-first); }
}
static int append(unsigned type, void *data, unsigned length) {
    if (length>PAYLOAD || tail-head+length+8>CAPACITY) return ENOBUFS;
    unsigned char h[8]; put32(h,type); put32(h+4,length);
    ringcopy(tail,h,8,1); ringcopy(tail+8,data,length,1); tail+=length+8;
    changed(); return 0;
}

static int spawn(unsigned slot, uint64_t flags, unsigned char *data, unsigned length, int *fds) {
    if (!slot || slot>=JOBS || flags>1 || length<9) return EINVAL;
    struct job *j=&jobs[slot];
    if (j->pid && !j->exited) return EBUSY;
    unsigned argc=get32(data), envc=get32(data+4);
    if (!argc || argc>1024 || envc>1024) return E2BIG;
    char **args=calloc(argc+envc+2,sizeof(char *));
    if (!args) return ENOMEM;
    unsigned pos=8;
    int error=0;
    for (unsigned i=0;i<argc+envc;i++) {
        if (pos>=length) { error=EINVAL; break; }
        args[i+(i>=argc)]=(char *)data+pos;
        void *end=memchr(data+pos,0,length-pos);
        if (!end) { error=EINVAL; break; }
        pos=(unsigned)((unsigned char *)end-data)+1;
    }
    if (pos!=length || data[8]!='/') error=EINVAL;
    if (error) { free(args); return error; }
    if (j->pid) {
        /* The unreaped leader pins its process group across stop/restart. */
        if (kill(-j->pid,SIGKILL) && errno!=ESRCH) { free(args); return errno; }
        waitpid(j->pid,NULL,0);
    }
    int ready[2];
    if (pipe2(ready,O_CLOEXEC)) { free(args); return errno; }
    pid_t parent=getpid(), pid=fork();
    if (pid<0) { error=errno; close(ready[0]); close(ready[1]); free(args); return error; }
    if (!pid) {
        close(ready[0]);
        int diagnostic=fcntl(ready[1],F_DUPFD_CLOEXEC,8);
        if (diagnostic<0) _exit(126);
        if (prctl(PR_SET_PDEATHSIG,SIGKILL) || getppid()!=parent || setsid()<0 ||
            fchdir(fds[0]) || (flags && ioctl(fds[1],TIOCSCTTY,0))) goto child_error;
        for (int i=0;i<3;i++) {
            if (dup2(fds[i+1],i)<0) goto child_error;
            int mode=fcntl(i,F_GETFL);
            if (mode<0 || fcntl(i,F_SETFL,mode&~O_NONBLOCK)) goto child_error;
        }
        /* CLOEXEC preserves the diagnostic pipe until exec reports success. */
        if (syscall(SYS_close_range,3u,UINT_MAX,4u)) goto child_error;
        sigset_t empty; sigemptyset(&empty); sigprocmask(SIG_SETMASK,&empty,NULL);
        umask(0022);
        execve(args[0],args,args+argc+1);
child_error:
        error=errno; { ssize_t ignored=write(diagnostic,&error,sizeof(error)); (void)ignored; }
        _exit(127);
    }
    close(ready[1]);
    ssize_t n;
    do { n=read(ready[0],&error,sizeof(error)); } while (n<0 && errno==EINTR);
    close(ready[0]); free(args);
    if (n) { if (n<0) error=errno; kill(pid,SIGKILL); waitpid(pid,NULL,0); memset(j,0,sizeof(*j)); return error; }
    *j=(struct job){.pid=pid}; changed(); return 0;
}

static void relay_close(unsigned i) {
    close(relays[i]->side[0].fd); close(relays[i]->side[1].fd);
    free(relays[i]); relays[i]=NULL;
}
static void relay_io(unsigned i, short a, short b) {
    struct relay *r=relays[i]; short events[]={a,b};
    for (unsigned k=0;k<2;k++) {
        struct stream *s=&r->side[k], *other=&r->side[1-k];
        if (events[k]&(POLLERR|POLLNVAL)) { relay_close(i); return; }
        if ((events[k]&(POLLIN|POLLHUP)) && !s->eof && s->end<sizeof(s->data)) {
            ssize_t n=read(s->fd,s->data+s->end,sizeof(s->data)-s->end);
            if (n>0) s->end+=(unsigned)n;
            else if (!n) s->eof=1;
            else if (errno!=EAGAIN && errno!=EINTR) { relay_close(i); return; }
        }
        if ((events[k]&POLLOUT) && other->end>other->start) {
            ssize_t n=send(s->fd,other->data+other->start,other->end-other->start,MSG_NOSIGNAL);
            if (n>0) other->start+=(unsigned)n;
            else if (n<0 && errno!=EAGAIN && errno!=EINTR) { relay_close(i); return; }
        }
        if (other->start==other->end) {
            other->start=other->end=0;
            if (other->eof==1) { shutdown(s->fd,SHUT_WR); other->eof=2; }
        }
    }
    if (r->side[0].eof==2 && r->side[1].eof==2) relay_close(i);
}

static int command(void) {
    unsigned char data[HEADER+PAYLOAD];
    union { struct cmsghdr align; char bytes[CMSG_SPACE(4*sizeof(int))]; } control={0};
    struct iovec iov={data,sizeof(data)};
    struct msghdr msg={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control.bytes,.msg_controllen=sizeof(control)};
    ssize_t received=recvmsg(client,&msg,MSG_CMSG_CLOEXEC);
    /* A failed recvmsg has no ancillary result, even if msg_controllen is unchanged. */
    if (received<0) {
        if (errno!=EAGAIN && errno!=EINTR) { close(client); client=-1; }
        return 0;
    }
    int fds[4], count=0;
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wsign-conversion"
    for (struct cmsghdr *c=CMSG_FIRSTHDR(&msg);c;c=CMSG_NXTHDR(&msg,c)) {
        if (c->cmsg_level==SOL_SOCKET && c->cmsg_type==SCM_RIGHTS) {
            unsigned n=(unsigned)(c->cmsg_len-CMSG_LEN(0))/sizeof(int);
            int *p=(int *)CMSG_DATA(c);
            for (unsigned i=0;i<n;i++) { if (count<4) fds[count++]=p[i]; else close(p[i]); }
        }
    }
#pragma GCC diagnostic pop
    unsigned error=0, op=received>=HEADER?get32(data+4):HELLO, length=0;
    uint64_t arg=0, aux=0;
    int output_fd=-1, closing=0;
    if (received<HEADER || msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC) || get32(data)!=MAGIC ||
        get32(data+8)!=(uint32_t)(received-HEADER) || get32(data+12)) { error=EPROTO; goto respond; }
    length=get32(data+8); arg=get64(data+16); aux=get64(data+24);
    unsigned char *body=data+HEADER;
    switch (op) {
    case GET:
        if (count || length || arg>=SLOTS) error=EINVAL;
        else if (slots[arg]<0) error=ENOENT;
        else output_fd=slots[arg];
        break;
    case PUT:
        if (count>1 || length || arg==0 || arg>=SLOTS || aux>=JOBS) error=EINVAL;
        else if (aux && jobs[aux].exited) error=ESRCH;
        else {
            if (slots[arg]>=0) close(slots[arg]);
            if (pending[arg]>=0) { close(pending[arg]); pending[arg]=-1; }
            slots[arg]=count?fds[--count]:-1; owners[arg]=(unsigned)aux; listening[arg]=0;
        }
        break;
    case SPAWN:
        if (count!=4 || arg==0 || arg>=JOBS) error=EINVAL;
        else error=(unsigned)spawn((unsigned)arg,aux,body,length,fds);
        if (!error) arg=(uint64_t)jobs[arg].pid;
        break;
    case STATUS:
        if (count || length || arg>=JOBS || !jobs[arg].pid) error=ENOENT;
        else { struct job *j=&jobs[arg]; arg=(uint64_t)j->pid; aux=((uint64_t)j->exited<<32)|j->status; }
        break;
    case SIGNAL:
        if (count || length || arg>=JOBS || !jobs[arg].pid || aux>64) error=EINVAL;
        else if (kill(-jobs[arg].pid,(int)aux) && errno!=ESRCH) error=(unsigned)errno;
        break;
    case RELAY: {
        if (count!=2 || length || arg>=SLOTS || (arg && pending[arg]<0)) { error=EINVAL; break; }
        unsigned i=0; while (i<RELAYS && relays[i]) i++;
        if (i==RELAYS) { error=ENOSPC; break; }
        int type; socklen_t size=sizeof(type);
        for (int k=0;k<2;k++) if (getsockopt(fds[k],SOL_SOCKET,SO_TYPE,&type,&size) || type!=SOCK_STREAM) error=EINVAL;
        if (error) break;
        struct relay *r=calloc(1,sizeof(*r));
        if (!r) { error=ENOMEM; break; }
        if (nonblock(fds[0]) || nonblock(fds[1])) { error=(unsigned)errno; free(r); break; }
        r->side[0].fd=fds[0]; r->side[1].fd=fds[1]; count=0; relays[i]=r;
        if (arg) { close(pending[arg]); pending[arg]=-1; }
        break;
    }
    case READ:
        if (count || length || arg<head || arg>tail) { error=EINVAL; break; }
        if (arg<tail) {
            unsigned char h[8]; ringcopy(arg,h,8,0); length=get32(h+4)+8;
            if (length>PAYLOAD || arg+length>tail) { error=EPROTO; break; }
            ringcopy(arg,body,length,0); arg+=length;
        }
        aux=tail;
        break;
    case COMMIT:
        if (count!=1 || length || arg<head || arg>tail) error=EINVAL;
        else {
            uint64_t cursor=head;
            while (cursor<arg) {
                unsigned char h[8]; ringcopy(cursor,h,8,0);
                unsigned n=get32(h+4);
                if (n>PAYLOAD || cursor+8+n>arg) break;
                cursor+=8+n;
            }
            if (cursor!=arg) { error=EINVAL; break; }
            int seals=fcntl(fds[0],F_GET_SEALS);
            if (seals<0 || (seals&(F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK))!=(F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK)) error=EINVAL;
            else { if (slots[0]>=0) close(slots[0]); slots[0]=fds[--count]; head=arg; }
        }
        break;
    case INPUT:
        if (count || master<0 || master_ended) error=EPIPE;
        else if (arg && arg<=replied) break;
        else if (!length || length>PAYLOAD-input_end) error=ENOBUFS;
        else {
            memcpy(input+input_end,body,length); input_end+=length;
            if (arg) replied=arg;
        }
        break;
    case EVENT:
        if (count || !journal || arg<RESIZE || arg>UINT32_MAX || length>PAYLOAD-8) error=EINVAL;
        else if (arg==RESIZE && (length!=4 || master<0 || !get32(body))) error=EINVAL;
        else {
            error=(unsigned)append((unsigned)arg,body,length);
            if (!error && arg==RESIZE) {
                struct winsize size={.ws_col=(unsigned short)(get32(body)>>16),.ws_row=(unsigned short)get32(body)};
                if (ioctl(master,TIOCSWINSZ,&size)) error=(unsigned)errno;
            }
            arg=tail;
        }
        break;
    case PTY: {
        if (count!=1 || length || master>=0 || journal) { error=EINVAL; break; }
        struct winsize size;
        if (ioctl(fds[0],TIOCGWINSZ,&size) || nonblock(fds[0])) { error=EINVAL; break; }
        char temporary[]=".keeper-journal-XXXXXX";
        int file=mkostemp(temporary,O_CLOEXEC);
        if (file<0) { error=(unsigned)errno; break; }
        /* Unlinked, bounded file-backed storage lives exactly as long as the guardian. */
        if (unlink(temporary)) { error=(unsigned)errno; close(file); break; }
        error=(unsigned)posix_fallocate(file,0,CAPACITY);
        if (error) { close(file); break; }
        journal=mmap(NULL,CAPACITY,PROT_READ|PROT_WRITE,MAP_SHARED,file,0); close(file);
        if (journal==MAP_FAILED) { journal=NULL; error=(unsigned)errno; break; }
        master=fds[--count]; break;
    }
    case CLOSE:
        if (count || length) error=EINVAL; else closing=2;
        break;
    case TRACK: {
        if (count!=1 || length) { error=EINVAL; break; }
        struct stat info;
        if (fstat(fds[0],&info) || (!S_ISFIFO(info.st_mode) && !S_ISSOCK(info.st_mode))) { error=EINVAL; break; }
        unsigned i=0; while (i<WATCHES && watches[i]>=0) i++;
        if (i==WATCHES) { error=ENOSPC; break; }
        if (nonblock(fds[0])) { error=(unsigned)errno; break; }
        watches[i]=fds[--count]; references++; armed=1;
        break;
    }
    case ACCEPT:
        if (count || length || arg==0 || arg>=SLOTS || aux>1 || slots[arg]<0) { error=EINVAL; break; }
        if (aux) { if (pending[arg]>=0) close(pending[arg]); pending[arg]=-1; break; }
        if (pending[arg]<0) {
            if (nonblock(slots[arg])) { error=(unsigned)errno; break; }
            pending[arg]=accept4(slots[arg],NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);
            if (pending[arg]<0) { error=(unsigned)errno; if (errno==EAGAIN) listening[arg]=1; break; }
        }
        output_fd=pending[arg];
        break;
    default: error=ENOSYS;
    }
respond:
    for (int i=0;i<count;i++) close(fds[i]);
    if (op!=READ || error) length=0;
    if (!closing && (packet(client,op,error,arg,aux,data+HEADER,length,&output_fd,output_fd>=0?1:0) || received<=0 || error==EPROTO)) {
        close(client); client=-1;
    }
    return closing;
}

static int child_action(pid_t pid, int signal_number) {
    if (signal_number) return kill(pid,signal_number) && errno!=ESRCH ? errno : 0;
    unsigned i=1; while (i<JOBS && jobs[i].pid!=pid) i++;
    if (i==JOBS) waitpid(pid,NULL,WNOHANG);
    return 0;
}

static int children(int signal_number) {
    int fd=open("/proc/thread-self/children",O_RDONLY|O_CLOEXEC);
    if (fd<0) return errno;
    char bytes[256]; unsigned pid=0; int error=0;
    for (;;) {
        ssize_t n=read(fd,bytes,sizeof(bytes));
        if (n<0) { if (errno==EINTR) continue; error=errno; break; }
        if (!n) break;
        for (ssize_t i=0;i<n;i++) {
            if (bytes[i]>='0' && bytes[i]<='9') pid=pid*10+(unsigned)(bytes[i]-'0');
            else if (pid) { int e=child_action((pid_t)pid,signal_number); if (e) error=e; pid=0; }
        }
    }
    if (pid) { int e=child_action((pid_t)pid,signal_number); if (e) error=e; }
    close(fd); return error;
}

static void reap(void) {
    for (unsigned i=1;i<JOBS;i++) if (jobs[i].pid && !jobs[i].exited) {
        siginfo_t status={0};
        if (!waitid(P_PID,(id_t)jobs[i].pid,&status,WEXITED|WNOHANG|WNOWAIT) && status.si_pid) {
            jobs[i].exited=1;
            jobs[i].status=(unsigned)status.si_status|(status.si_code==CLD_EXITED?0:0x80000000u);
            for (unsigned k=1;k<SLOTS;k++) if (owners[k]==i && slots[k]>=0) { close(slots[k]); slots[k]=-1; owners[k]=0; }
            changed();
        }
    }
    children(0);
}

int main(void) {
    umask(0077);
    if (syscall(SYS_close_range,4u,UINT_MAX,0)) fail("close inherited descriptors");
    if (prctl(PR_SET_PDEATHSIG,0) || prctl(PR_SET_CHILD_SUBREAPER,1)) fail("guardian setup");
    if (getsid(0)!=getpid() && setsid()<0) fail("setsid");
    struct stat dir;
    if (fstat(DIRECTORY,&dir) || !S_ISDIR(dir.st_mode) || dir.st_uid!=geteuid() || (dir.st_mode&0077)) { errno=EACCES; fail("private directory required"); }
    if (flock(DIRECTORY,LOCK_EX|LOCK_NB)) fail("directory already owned");
    if (fchdir(DIRECTORY)) fail("directory");
    const char *paths[]={"keeper.sock","keeper.sock.new"};
    for (unsigned i=0;i<2;i++) {
        struct stat st;
        if (!lstat(paths[i],&st)) {
            if (!S_ISSOCK(st.st_mode) || st.st_uid!=geteuid()) { errno=EEXIST; fail("unsafe socket path"); }
            if (unlink(paths[i])) fail("remove stale socket");
        } else if (errno!=ENOENT) fail("inspect socket");
    }
    int listener=socket(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
    struct sockaddr_un address={.sun_family=AF_UNIX,.sun_path="keeper.sock.new"};
    if (listener<0 || bind(listener,(struct sockaddr *)&address,sizeof(address)) || chmod(paths[1],0600) || listen(listener,8) || rename(paths[1],paths[0])) fail("publish socket");
    struct stat bound;
    if (lstat(paths[0],&bound)) fail("stat socket");
    for (unsigned i=0;i<SLOTS;i++) slots[i]=pending[i]=-1;
    for (unsigned i=0;i<WATCHES;i++) watches[i]=-1;
    notification=eventfd(0,EFD_CLOEXEC|EFD_NONBLOCK);
    if (notification<0) fail("eventfd");
    sigset_t signals; sigemptyset(&signals);
    int sigs[]={SIGCHLD,SIGTERM,SIGINT,SIGHUP};
    for (unsigned i=0;i<4;i++) { signal(sigs[i],SIG_DFL); sigaddset(&signals,sigs[i]); }
    signal(SIGPIPE,SIG_IGN);
    if (sigprocmask(SIG_SETMASK,&signals,NULL)) fail("signals");
    int signal_fd=signalfd(-1,&signals,SFD_CLOEXEC|SFD_NONBLOCK);
    if (signal_fd<0) fail("signalfd");
    int null=open("/dev/null",O_RDWR|O_CLOEXEC);
    if (null<0) fail("null");
    for (int i=0;i<3;i++) if (dup2(null,i)<0) fail("detach stdio");
    close(null);
    int stopping=0;
    while (!stopping) {
        struct pollfd fds[4+2*RELAYS+WATCHES+SLOTS]={
            {signal_fd,POLLIN,0},{listener,POLLIN,0},{client,POLLIN,0},
            {master,(short)((!master_ended && jobs[1].pid && tail-head+16392<=CAPACITY?POLLIN:0)|(input_end>input_start?POLLOUT:0)),0}
        };
        if (!fds[3].events) fds[3].fd=-1;
        for (unsigned i=0;i<RELAYS;i++) for (unsigned k=0;k<2;k++) {
            struct relay *r=relays[i];
            fds[4+2*i+k].fd=r?r->side[k].fd:-1;
            if (r) fds[4+2*i+k].events=(short)((!r->side[k].eof && r->side[k].end<4096?POLLIN:0)|(r->side[1-k].end>r->side[1-k].start?POLLOUT:0));
        }
        for (unsigned i=0;i<WATCHES;i++) fds[4+2*RELAYS+i]=(struct pollfd){watches[i],POLLIN,0};
        for (unsigned i=0;i<SLOTS;i++) fds[4+2*RELAYS+WATCHES+i]=(struct pollfd){listening[i]?slots[i]:-1,POLLIN,0};
        if (poll(fds,4+2*RELAYS+WATCHES+SLOTS,-1)<0) { if (errno==EINTR) continue; break; }
        if (fds[0].revents) {
            struct signalfd_siginfo event;
            while (read(signal_fd,&event,sizeof(event))==sizeof(event)) if (event.ssi_signo!=SIGCHLD) stopping=1;
            reap();
        }
        if (fds[2].revents) stopping|=command();
        if (fds[3].revents && master>=0) {
            if (input_end>input_start) {
                ssize_t n=write(master,input+input_start,input_end-input_start);
                if (n>0) input_start+=(unsigned)n;
                if (input_start==input_end) input_start=input_end=0;
            }
            if (!master_ended && tail-head+16392<=CAPACITY) {
                unsigned char bytes[16384]; ssize_t n=read(master,bytes,sizeof(bytes));
                if (n>0) append(OUTPUT,bytes,(unsigned)n);
                else if (!n || (n<0 && errno==EIO && jobs[1].pid)) {
                    append(END,NULL,0); master_ended=1; input_start=input_end=0;
                }
            }
        }
        for (unsigned i=0;i<RELAYS;i++) if (relays[i] && (fds[4+2*i].revents || fds[5+2*i].revents)) relay_io(i,fds[4+2*i].revents,fds[5+2*i].revents);
        for (unsigned i=0;i<WATCHES;i++) if (watches[i]>=0 && fds[4+2*RELAYS+i].revents) {
            char byte; ssize_t n=read(watches[i],&byte,1);
            if (n>=0 || (errno!=EAGAIN && errno!=EINTR)) { close(watches[i]); watches[i]=-1; references--; }
        }
        if (armed && !references) stopping|=1;
        for (unsigned i=0;i<SLOTS;i++) if (listening[i] && fds[4+2*RELAYS+WATCHES+i].revents) { listening[i]=0; changed(); }
        if (fds[1].revents) {
            int incoming=accept4(listener,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);
            if (incoming>=0) {
                struct ucred peer; socklen_t size=sizeof(peer);
                if (getsockopt(incoming,SOL_SOCKET,SO_PEERCRED,&peer,&size) || (peer.uid!=geteuid() && peer.uid!=0)) close(incoming);
                else if (packet(incoming,HELLO,client>=0?EBUSY:0,head,tail,NULL,0,&notification,client<0?1u:0u) || client>=0) close(incoming);
                else client=incoming;
            }
        }
    }
    /* Never claim successful cleanup while an elevated or uninterruptible child lives. */
    for (;;) {
        int error=children(SIGKILL);
        int status; pid_t pid=waitpid(-1,&status,WNOHANG);
        if (pid<0 && errno==ECHILD) break;
        if (error && client>=0) { packet(client,CLOSE,(unsigned)error,0,0,NULL,0,NULL,0); close(client); client=-1; }
        if (pid<=0) { struct timespec delay={0,20000000}; nanosleep(&delay,NULL); }
    }
    changed();
    struct stat now;
    if (!lstat(paths[0],&now) && now.st_dev==bound.st_dev && now.st_ino==bound.st_ino) unlink(paths[0]);
    flock(DIRECTORY,LOCK_UN);
    if (client>=0 && (stopping&2)) packet(client,CLOSE,0,0,0,NULL,0,NULL,0);
    return 0;
}
