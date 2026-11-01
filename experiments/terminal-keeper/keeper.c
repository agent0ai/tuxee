#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
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

enum { MASTER = 3, SLAVE = 4, DIRECTORY = 5, EXITED = 1, SIGNALED = 2, BUSY = 4 };
static const char socket_name[] = "keeper.sock";
static const char pending_name[] = "keeper.sock.new";

static void diagnostic(const char *operation) {
    unsigned error = (unsigned)errno;
    char digits[12], *end = digits + sizeof(digits), *start = end;
    do { *--start = (char)('0' + error % 10); error /= 10; } while (error);
    struct iovec parts[] = {
        { (void *)operation, strlen(operation) }, { ": errno ", 8 },
        { start, (size_t)(end - start) }, { "\n", 1 }
    };
    ssize_t ignored = writev(2, parts, 4);
    (void)ignored;
}

static void fail(const char *operation) {
    diagnostic(operation);
    _exit(1);
}

static int64_t milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) fail("clock_gettime");
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void signal_children(int descriptor, int signal_number) {
    if (lseek(descriptor, 0, SEEK_SET) < 0) fail("rewind children");
    char bytes[128];
    unsigned pid = 0;
    for (;;) {
        ssize_t length = read(descriptor, bytes, sizeof(bytes));
        if (length < 0) { if (errno == EINTR) continue; fail("read children"); }
        if (!length) break;
        for (ssize_t i = 0; i < length; i++) {
            if (bytes[i] >= '0' && bytes[i] <= '9') pid = pid * 10 + (unsigned)(bytes[i] - '0');
            else if (pid) { kill((pid_t)pid, signal_number); pid = 0; }
        }
    }
    if (pid) kill((pid_t)pid, signal_number);
}

static int status_packet(int socket, pid_t child, unsigned flags, unsigned status, int descriptor) {
    uint32_t values[] = { htonl(1), htonl((uint32_t)child), htonl(flags), htonl(status) };
    struct iovec data = { values, sizeof(values) };
    union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(int))]; } ancillary = {0};
    struct msghdr message = { .msg_iov = &data, .msg_iovlen = 1 };
    if (descriptor >= 0) {
        message.msg_control = ancillary.bytes;
        message.msg_controllen = sizeof(ancillary.bytes);
        struct cmsghdr *header = CMSG_FIRSTHDR(&message);
        header->cmsg_level = SOL_SOCKET;
        header->cmsg_type = SCM_RIGHTS;
        header->cmsg_len = CMSG_LEN(sizeof(int));
        memcpy(CMSG_DATA(header), &descriptor, sizeof(descriptor));
    }
    return sendmsg(socket, &message, MSG_NOSIGNAL) == sizeof(values) ? 0 : -1;
}

int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/') { errno = EINVAL; fail("absolute command required"); }
    umask(0077);
    if (syscall(SYS_close_range, 6u, UINT_MAX, 0)) fail("close inherited descriptors");
    if (prctl(PR_SET_PDEATHSIG, 0)) fail("clear parent death signal");
    if (prctl(PR_SET_CHILD_SUBREAPER, 1)) fail("own orphan descendants");
    if (getsid(0) != getpid() && setsid() < 0) fail("setsid");

    struct stat directory, slave, peer;
    if (fstat(DIRECTORY, &directory) || !S_ISDIR(directory.st_mode) ||
        directory.st_uid != geteuid() || (directory.st_mode & 0077)) {
        errno = EACCES; fail("private terminal directory required");
    }
    if (flock(DIRECTORY, LOCK_EX | LOCK_NB)) fail("terminal already owned");
    int tty_peer = ioctl(MASTER, TIOCGPTPEER, O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (tty_peer < 0 || fstat(tty_peer, &peer) || fstat(SLAVE, &slave) ||
        !S_ISCHR(slave.st_mode) || slave.st_rdev != peer.st_rdev ||
        slave.st_dev != peer.st_dev || slave.st_ino != peer.st_ino) {
        errno = EINVAL; fail("matching PTY descriptors required");
    }
    close(tty_peer);
    // Keep the command's cwd while binding a short socket name in its pinned directory.
    int cwd = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (cwd < 0 || fchdir(DIRECTORY)) fail("terminal directory");
    struct stat existing;
    const char *paths[] = { socket_name, pending_name };
    for (unsigned i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
        if (!fstatat(DIRECTORY, paths[i], &existing, AT_SYMLINK_NOFOLLOW)) {
            if (!S_ISSOCK(existing.st_mode) || existing.st_uid != geteuid()) {
                errno = EEXIST; fail("unsafe existing socket path");
            }
            if (unlink(paths[i])) fail("remove stale socket");
        } else if (errno != ENOENT) fail("inspect socket path");
    }

    int listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    memcpy(address.sun_path, pending_name, sizeof(pending_name));
    if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) ||
        chmod(pending_name, 0600) || listen(listener, 8)) fail("create control socket");
    // Publish only after listen, so discovery cannot observe a half-created endpoint.
    if (renameat(DIRECTORY, pending_name, DIRECTORY, socket_name)) fail("publish socket");
    struct stat bound;
    if (lstat(socket_name, &bound)) fail("stat socket");

    sigset_t signals;
    sigemptyset(&signals);
    sigaddset(&signals, SIGCHLD);
    sigaddset(&signals, SIGTERM);
    sigaddset(&signals, SIGINT);
    sigaddset(&signals, SIGHUP);
    struct sigaction default_signal = { .sa_handler = SIG_DFL };
    sigemptyset(&default_signal.sa_mask);
    int reset[] = { SIGCHLD, SIGTERM, SIGINT, SIGHUP, SIGPIPE };
    for (unsigned i = 0; i < sizeof(reset) / sizeof(reset[0]); i++)
        if (sigaction(reset[i], &default_signal, NULL)) fail("reset signals");
    if (sigprocmask(SIG_SETMASK, &signals, NULL)) fail("block signals");
    int signal_fd = signalfd(-1, &signals, SFD_CLOEXEC | SFD_NONBLOCK);
    if (signal_fd < 0) fail("signalfd");
    int children_fd = open("/proc/thread-self/children", O_RDONLY | O_CLOEXEC);
    if (children_fd < 0) fail("open children");
    pid_t keeper = getpid();
    pid_t child = fork();
    if (child < 0) fail("fork");
    if (!child) {
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != keeper ||
            setsid() < 0 || ioctl(SLAVE, TIOCSCTTY, 0) || fchdir(cwd)) _exit(126);
        for (int i = 0; i < 3; i++) if (dup2(SLAVE, i) < 0) _exit(126);
        if (syscall(SYS_close_range, 3u, UINT_MAX, 0)) _exit(126);
        umask(0022);
        sigemptyset(&signals);
        if (sigprocmask(SIG_SETMASK, &signals, NULL)) _exit(126);
        execve(argv[1], argv + 1, environ);
        diagnostic("exec terminal command");
        _exit(127);
    }
    close(cwd);
    close(SLAVE);
    // Startup descriptors are the entire interface; never retain an inherited output pipe.
    int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null_fd < 0) fail("open /dev/null");
    for (int i = 0; i < 3; i++) if (dup2(null_fd, i) < 0) fail("detach stdio");
    if (null_fd > 2) close(null_fd);

    int client = -1;
    unsigned flags = 0, status = 0;
    int64_t stopping = 0;
    for (;;) {
        struct pollfd fds[] = {
            { signal_fd, POLLIN, 0 }, { listener, POLLIN, 0 }, { client, POLLIN, 0 }
        };
        int timeout = stopping ? (int)(stopping - milliseconds()) : -1;
        if (stopping && timeout < 0) timeout = 0;
        int ready = poll(fds, 3, timeout);
        if (ready < 0) { if (errno == EINTR) continue; break; }
        if (fds[0].revents & POLLIN) {
            struct signalfd_siginfo event;
            while (read(signal_fd, &event, sizeof(event)) == sizeof(event)) {
                if (event.ssi_signo != SIGCHLD && !stopping) stopping = 1;
            }
        }
        int child_status;
        pid_t reaped;
        while ((reaped = waitpid(-1, &child_status, WNOHANG)) > 0) {
            if (reaped == child) {
                flags = EXITED | (WIFEXITED(child_status) ? 0 : SIGNALED);
                status = (unsigned)(WIFEXITED(child_status) ? WEXITSTATUS(child_status) : WTERMSIG(child_status));
                if (client >= 0 && status_packet(client, child, flags, status, -1)) {
                    close(client); client = -1;
                }
            }
        }
        int no_children = reaped < 0 && errno == ECHILD;
        if (client >= 0 && fds[2].revents) {
            char command[2];
            ssize_t received = recv(client, command, sizeof(command), MSG_DONTWAIT);
            if (received == 1 && command[0] == 'X') { if (!stopping) stopping = 1; }
            else if (received >= 0 || (errno != EAGAIN && errno != EINTR)) {
                close(client); client = -1;
            }
        }
        if (stopping == 1) {
            // Only our direct, unreaped children are signalled; their PIDs cannot be reused.
            signal_children(children_fd, SIGHUP);
            stopping = milliseconds() + 1000;
        }
        if (stopping && (no_children || milliseconds() >= stopping)) break;
        if (!stopping && (fds[1].revents & POLLIN)) {
            int incoming = accept4(listener, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
            if (incoming < 0) continue;
            struct ucred peer_credentials;
            socklen_t size = sizeof(peer_credentials);
            if (getsockopt(incoming, SOL_SOCKET, SO_PEERCRED, &peer_credentials, &size) ||
                (peer_credentials.uid != geteuid() && peer_credentials.uid != 0)) {
                close(incoming); continue;
            }
            if (status_packet(incoming, child, flags | (client >= 0 ? BUSY : 0), status,
                              client >= 0 ? -1 : MASTER) || client >= 0) close(incoming);
            else client = incoming;
        }
    }
    for (;;) {
        // shortcut: elevated or uninterruptible children can block close; coordinate privileged cleanup before production.
        // Subreaping adopts further descendants after each killed parent, including setsid jobs.
        signal_children(children_fd, SIGKILL);
        if (waitpid(-1, NULL, 0) < 0 && errno == ECHILD) break;
    }
    close(MASTER);
    if (!fstatat(DIRECTORY, socket_name, &existing, AT_SYMLINK_NOFOLLOW) &&
        existing.st_dev == bound.st_dev && existing.st_ino == bound.st_ino) unlink(socket_name);
    return 0;
}
