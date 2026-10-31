package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
	"tuxee/internal/files"
	"tuxee/internal/i18n"
	"tuxee/internal/identity"
	"tuxee/internal/processes"
	"tuxee/internal/server"
	"tuxee/internal/service"
	"tuxee/internal/terminal"
	"tuxee/internal/tlsmanager"
	"tuxee/internal/update"
	"tuxee/web"
)

var version = "0.0.0"

var errRestart = errors.New("runtime restart requested")

type config struct {
	Bind          string `json:"bind,omitempty"`
	State         string `json:"state"`
	HTTP          bool   `json:"http,omitempty"`
	HTTPPort      *int   `json:"httpPort,omitempty"`
	HTTPSPort     *int   `json:"httpsPort,omitempty"`
	Hosts         string `json:"hosts"`
	ACME          string `json:"acme"`
	ACMEDirectory string `json:"acmeDirectory"`
	Email         string `json:"email"`
	PAM           string `json:"pam"`
	Origin        string `json:"origin,omitempty"`
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "__auth":
			if identity.RunAuthHelper() != nil {
				os.Exit(1)
			}
			return
		case "__files":
			if err := files.Worker(); err != nil {
				_ = json.NewEncoder(os.Stderr).Encode(i18n.Describe(err))
				os.Exit(1)
			}
			return
		case "__processes":
			if err := processes.Worker(); err != nil {
				_ = json.NewEncoder(os.Stderr).Encode(i18n.Describe(err))
				os.Exit(1)
			}
			return
		}
	}
	if err := run(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		var reported reportedError
		if !errors.As(err, &reported) {
			fmt.Fprintln(os.Stderr, "tuxee:", err)
		}
		os.Exit(1)
	}
}
func help() {
	fmt.Println(`Tuxee - the most convenient Linux for servers and agents.

  tuxee serve [options]                   Run in the foreground
  tuxee healthcheck [serve options]       Probe the configured local listener
  tuxee ports [--http-port N] [--https-port N] [--config PATH]
                                         Show/save listening ports; 0 disables
  tuxee service install [--name tuxee] [serve options]
                                         Install and enable a systemd unit
  tuxee service uninstall [--name tuxee]  Unregister; preserve configuration/state
  tuxee service start|stop|restart|status|logs [--name tuxee]
                                         Use the system service manager
  tuxee restart [--name tuxee] [--state directory]
                                         Restart the running Tuxee runtime
  tuxee version                          Print version
  tuxee update [--check] [--name tuxee]    Check/install the latest stable release
  tuxee upgrade [--check] [--name tuxee]   Alias for update

Run tuxee serve --help for listener, TLS and configuration options.
Native operation requires root and Linux PAM. Docker manages container users.
Live terminals survive logout/disconnection, but end when Tuxee stops.`)
}
func run(args []string) error {
	if len(args) == 0 {
		help()
		return nil
	}
	switch args[0] {
	case "help", "--help", "-h":
		help()
		return nil
	case "version", "--version":
		fmt.Println("Tuxee", version)
		return nil
	case "__install":
		if len(args) != 1 {
			return errors.New("unexpected installation arguments")
		}
		if err := update.Bootstrap(context.Background(), version); err != nil {
			return err
		}
		fmt.Printf("Installed Tuxee %s: %s\nRun: sudo tuxee serve\n", version, update.CommandPath)
		if service.Available() == nil {
			fmt.Println("Start at boot: sudo tuxee service install\nStart now: sudo tuxee service start")
			fmt.Println("Apply an update to the existing default service: sudo tuxee restart")
		} else {
			fmt.Println("No running systemd manager; use tuxee serve with your existing supervisor.")
		}
		if !strings.Contains(":"+os.Getenv("PATH")+":", ":/usr/local/bin:") {
			fmt.Println("Add the command to this shell: export PATH=\"/usr/local/bin:$PATH\"")
		}
		fmt.Println("Omit sudo when already root. Installation does not restart Tuxee.")
		fmt.Println("Running processes use the new version after you restart them. Restarting ends all terminal sessions.")
		return nil
	case "update", "upgrade":
		return runUpdate(args[1:])
	case "ports":
		return runPorts(args[1:], os.Stdout)
	case "restart":
		return runRestart(args[1:])
	case "serve", "healthcheck":
		value, _, err := parseConfig(args[1:], false)
		if err != nil {
			return err
		}
		if args[0] == "healthcheck" {
			return healthcheck(value)
		}
		bind := value.Bind
		if err := serve(&value); !errors.Is(err, errRestart) {
			return err
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		args := append([]string(nil), os.Args...)
		if value.Bind != bind {
			if args[len(args)-1] == "--" {
				args = args[:len(args)-1]
			}
			args = append(args, "--bind", value.Bind)
		}
		return syscall.Exec(executable, args, os.Environ())
	case "service":
		if len(args) < 2 {
			return errors.New("use service install|uninstall|start|stop|restart|status|logs")
		}
		if args[1] == "install" {
			value, name, err := parseConfig(args[2:], true)
			if err != nil {
				return err
			}
			data, _ := json.MarshalIndent(value, "", "  ")
			return service.Install(name, value.State, append(data, '\n'))
		}
		if args[1] == "uninstall" {
			name, err := serviceName(args[2:])
			if err != nil {
				return err
			}
			return service.Uninstall(name)
		}
		name, err := serviceName(args[2:])
		if err != nil {
			return err
		}
		return service.Lifecycle(args[1], name)
	default:
		return fmt.Errorf("unknown command %q; use tuxee help", args[0])
	}
}

func runUpdate(args []string) (err error) {
	f := flag.NewFlagSet("update", flag.ContinueOnError)
	check := f.Bool("check", false, "only check the latest stable release")
	name := f.String("name", "", "update this named managed service installation")
	target, err := os.Executable()
	if err != nil {
		return err
	}
	restartCommand := func() string {
		command := update.Command(target) + " restart"
		if *name != "" && service.ValidateName(*name) == nil {
			command += " --name " + *name
		}
		if os.Geteuid() != 0 {
			command = "sudo " + command
		}
		return command
	}
	defer func() {
		if err != nil && !errors.Is(err, flag.ErrHelp) {
			if *check {
				fmt.Fprintln(os.Stderr, "\n"+colored(os.Stderr, "31", "Update check failed: "+err.Error()))
			} else {
				updateResult(os.Stderr, "Update failed: "+err.Error(), restartCommand(), true)
			}
			err = reportedError{err}
		}
	}()
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected update arguments")
	}
	if *name != "" {
		selected, err := service.Executable(*name)
		if err != nil {
			return err
		}
		target = selected
	}
	client := update.NewClient()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	current, err := update.InstalledVersion(ctx, target)
	if err != nil {
		return err
	}
	release, err := client.Latest(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("Installed version: %s\nLatest stable release: %s\nInstallation: %s\n", current, release.Tag, target)
	if *check {
		if !update.Newer(release.Tag, current) {
			fmt.Println("No newer stable release.")
		} else {
			fmt.Println("A newer version is available; repeat without --check to install it.")
		}
		return nil
	}
	fmt.Println("In progress...")
	applied, err := client.Apply(ctx, release, target)
	if err != nil {
		return err
	}
	if !applied {
		updateResult(os.Stdout, "Tuxee is up to date; installation unchanged.", restartCommand(), false)
		return nil
	}
	updateResult(os.Stdout, "Successfully updated Tuxee to "+release.Tag+".", restartCommand(), false)
	return nil
}
func serviceName(args []string) (string, error) {
	f := flag.NewFlagSet("service", flag.ContinueOnError)
	name := f.String("name", "tuxee", "systemd service name")
	if err := f.Parse(args); err != nil {
		return "", err
	}
	if f.NArg() != 0 {
		return "", errors.New("unexpected service arguments")
	}
	return *name, service.ValidateName(*name)
}
func parseConfig(args []string, install bool) (config, string, error) {
	configPath := ""
	for i, arg := range args {
		if arg == "--config" || arg == "-config" {
			if i+1 < len(args) {
				configPath = args[i+1]
			}
		}
		if strings.HasPrefix(arg, "--config=") || strings.HasPrefix(arg, "-config=") {
			_, configPath, _ = strings.Cut(arg, "=")
		}
	}
	value, err := loadConfig(configPath)
	if err != nil {
		return value, "", err
	}
	f := flag.NewFlagSet("serve", flag.ContinueOnError)
	for _, port := range []struct {
		name, env string
		value     **int
	}{{"http-port", "TUXEE_HTTP_PORT", &value.HTTPPort}, {"https-port", "TUXEE_HTTPS_PORT", &value.HTTPSPort}} {
		if raw, present := os.LookupEnv(port.env); present {
			n, err := parsePort(raw)
			if err != nil {
				return value, "", fmt.Errorf("%s: %w", port.env, err)
			}
			*port.value = &n
		}
		f.Func(port.name, "listening port, 0 disables; overrides "+port.env+" and JSON (defaults: HTTP 80, HTTPS 443)", func(raw string) error {
			n, err := parsePort(raw)
			if err == nil {
				*port.value = &n
			}
			return err
		})
	}
	name := "tuxee"
	if install {
		f.StringVar(&name, "name", name, "systemd service name")
	}
	f.StringVar(&configPath, "config", configPath, "JSON configuration file; flags override its values")
	f.StringVar(&value.Bind, "bind", value.Bind, "legacy single-listener address (default :443); cannot combine with independent ports")
	f.StringVar(&value.State, "state", value.State, "absolute server state directory")
	f.BoolVar(&value.HTTP, "http", value.HTTP, "explicit plain HTTP (for loopback/protected proxy use)")
	f.StringVar(&value.Hosts, "hosts", value.Hosts, "optional comma-separated TLS names/IPs to enroll at startup; first is the no-SNI name")
	f.StringVar(&value.ACME, "acme", value.ACME, "auto/on (public names/IPs, any listener port), or off")
	f.StringVar(&value.ACMEDirectory, "acme-directory", value.ACMEDirectory, "alternate ACME directory, such as Let's Encrypt staging")
	f.StringVar(&value.Email, "email", value.Email, "optional ACME account email")
	f.StringVar(&value.PAM, "pam", value.PAM, "host PAM authentication/account service")
	f.StringVar(&value.Origin, "origin", value.Origin, "optional public URL override; reverse proxies work without it")
	if err := f.Parse(args); err != nil {
		return value, name, err
	}
	if f.NArg() != 0 {
		return value, name, errors.New("unexpected arguments")
	}
	if install && value.State == "/var/lib/tuxee" && name != "tuxee" {
		value.State = filepath.Join("/var/lib", name)
	}
	if err := service.ValidateName(name); err != nil {
		return value, name, err
	}
	return value, name, value.validate()
}

func loadConfig(path string) (config, error) {
	value := config{State: "/var/lib/tuxee", ACME: "auto", PAM: "login"}
	if path == "" {
		return value, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return value, err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 65537))
	d.DisallowUnknownFields()
	object := &value
	if err := d.Decode(&object); err != nil {
		return value, err
	}
	if object == nil || d.Decode(new(any)) != io.EOF {
		return value, errors.New("configuration must contain one JSON object")
	}
	return value, nil
}

func (value config) validate() error {
	if !filepath.IsAbs(value.State) || value.State == "/" {
		return errors.New("state must be an absolute dedicated directory")
	}
	if _, err := value.listeners(); err != nil {
		return err
	}
	if value.ACME != "auto" && value.ACME != "on" && value.ACME != "off" {
		return errors.New("acme must be auto, on, or off")
	}
	if value.PAM == "" || strings.ContainsAny(value.PAM, "/\x00") {
		return errors.New("invalid PAM service")
	}
	return server.ValidateOrigin(value.Origin)
}

func parsePort(raw string) (int, error) {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > 65535 || strings.IndexFunc(raw, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return 0, errors.New("port must be a decimal integer from 0 to 65535 (0 disables the protocol)")
	}
	return n, nil
}

type listenerConfig struct {
	address string
	https   bool
}

func (value config) listeners() ([]listenerConfig, error) {
	if value.Bind != "" || value.HTTP {
		if value.HTTPPort != nil || value.HTTPSPort != nil {
			return nil, errors.New("cannot combine legacy bind/http with httpPort/httpsPort, port flags or TUXEE_HTTP_PORT/TUXEE_HTTPS_PORT; remove legacy settings to use independent ports")
		}
		address := value.Bind
		if address == "" {
			address = ":443"
		}
		if _, _, err := net.SplitHostPort(address); err != nil {
			return nil, fmt.Errorf("bind: %w", err)
		}
		return []listenerConfig{{address, !value.HTTP}}, nil
	}
	httpPort, httpsPort := 80, 443
	if value.HTTPPort != nil {
		httpPort = *value.HTTPPort
	}
	if value.HTTPSPort != nil {
		httpsPort = *value.HTTPSPort
	}
	if httpPort < 0 || httpPort > 65535 || httpsPort < 0 || httpsPort > 65535 {
		return nil, errors.New("httpPort and httpsPort must be integers from 0 to 65535 (0 disables the protocol)")
	}
	if httpPort != 0 && httpPort == httpsPort {
		return nil, errors.New("HTTP and HTTPS ports must differ")
	}
	var listeners []listenerConfig
	if httpsPort != 0 {
		listeners = append(listeners, listenerConfig{":" + strconv.Itoa(httpsPort), true})
	}
	if httpPort != 0 {
		listeners = append(listeners, listenerConfig{":" + strconv.Itoa(httpPort), false})
	}
	return listeners, nil
}

func healthcheck(value config) error {
	listeners, err := value.listeners()
	if err != nil {
		return err
	}
	if len(listeners) == 0 {
		return errors.New("HTTP and HTTPS are disabled; no listener to probe")
	}
	listener := listeners[0]
	host, port, _ := net.SplitHostPort(listener.address)
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	scheme := "http"
	if listener.https {
		scheme = "https"
	}
	// Local liveness only, matching the image's former curl --insecure probe.
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 4 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(scheme + "://" + net.JoinHostPort(host, port) + "/health")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("health returned %s", response.Status)
	}
	return nil
}

func lockState(path string) (*os.File, error) {
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("state must be a real directory")
	}
	if err = os.Chmod(path, 0700); err != nil {
		return nil, err
	}
	fd, err := unix.Open(filepath.Join(path, "server.lock"), unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "server.lock")
	if err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another Tuxee process is using this state directory")
	}
	return f, nil
}
func serve(value *config) error {
	configs, err := value.listeners()
	if err != nil {
		return err
	}
	if len(configs) == 0 {
		return errors.New("HTTP and HTTPS are disabled; no listeners configured")
	}
	if os.Geteuid() != 0 {
		return errors.New("host user authentication and process credentials require root")
	}
	syscall.Umask(0077)
	lock, err := lockState(value.State)
	if err != nil {
		return err
	}
	defer lock.Close()
	instanceID, err := loadInstanceID(value.State)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	listeners := make([]net.Listener, 0, len(configs))
	for _, config := range configs {
		listener, err := net.Listen("tcp", config.address)
		if err != nil {
			return fmt.Errorf("listen %s: %w", config.address, err)
		}
		defer listener.Close()
		listeners = append(listeners, listener)
		if _, port, _ := net.SplitHostPort(config.address); value.Bind != "" && port == "0" {
			// Keep the selected ephemeral port when the runtime re-executes.
			value.Bind = listener.Addr().String()
		}
	}
	if err := update.Setup(ctx, version, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "Tuxee setup failed; will retry on next start: %v\n", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	terminals := terminal.NewManager()
	terminals.HistoryInstance = instanceID
	terminals.StartArchives(value.State)
	defer terminals.Close()
	gate := identity.NewGate(value.PAM)
	var tls *tlsmanager.Manager
	if configs[0].https {
		var hosts []string
		for _, host := range strings.Split(value.Hosts, ",") {
			if host = strings.TrimSpace(host); host != "" {
				hosts = append(hosts, host)
			}
		}
		tls, err = tlsmanager.New(tlsmanager.Options{Directory: filepath.Join(value.State, "tls"), Hosts: hosts, Email: value.Email, ACMEDirectory: value.ACMEDirectory, Automatic: value.ACME != "off"})
		if err != nil {
			return err
		}
		go tls.Run(ctx)
	}
	app := server.New(instanceID, gate, terminals, tls, value.Origin, web.Assets())
	defer app.Close()
	restart := make(chan struct{}, 1)
	app.Restart = func() { restart <- struct{}{} }
	restartSignal := make(chan os.Signal, 1)
	signal.Notify(restartSignal, syscall.SIGUSR1)
	// Ignore late duplicate requests across exec, until the new runtime is ready.
	defer signal.Ignore(syscall.SIGUSR1)
	unregister, err := registerRuntime(runtimeDirectory, value.State)
	if err != nil {
		return err
	}
	defer unregister()
	app.Version = version
	app.Updates = update.NewChecker(version)
	go app.Updates.Run(ctx)
	go app.Prune(ctx)
	errorsCh := make(chan error, len(listeners))
	var servers []*http.Server
	for i, listener := range listeners {
		httpServer := &http.Server{Handler: app, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
		servers = append(servers, httpServer)
		scheme := "http"
		if configs[i].https {
			scheme = "https"
			httpServer.TLSConfig = tls.TLSConfig()
		}
		fmt.Printf("Tuxee %s listening at %s://%s — state %s\n", version, scheme, listener.Addr(), value.State)
		go func() {
			if httpServer.TLSConfig != nil {
				errorsCh <- server.ServeHTTPS(httpServer, listener)
			} else {
				errorsCh <- httpServer.Serve(listener)
			}
		}()
	}
	if tls != nil {
		fmt.Println("Local certificates require client trust until public ACME validation succeeds. HSTS is off.")
	}
	select {
	case <-ctx.Done():
	case <-restart:
		err = errRestart
	case <-restartSignal:
		err = errRestart
	case err = <-errorsCh:
		stop()
	}
	unregister()
	app.Close()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, httpServer := range servers {
		_ = httpServer.Shutdown(shutdown)
	}
	terminals.Close()
	if errors.Is(err, errRestart) && ctx.Err() != nil {
		return nil
	}
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}
