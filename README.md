<p align="center">
  <img src="web/tuxee-logo-vertical.webp" alt="Tuxee" width="220">
</p>

<p align="center">
  A Linux workspace in your browser.
</p>

Manage files, edit code, use persistent terminals and monitor system resources
in a responsive, dockable workspace. Tuxee ships as one Go executable with a
locally bundled web UI and authenticates against Linux accounts.

## Docker

```sh
ROOT_PASSWORD='your-password' docker compose up --build -d
```

Open **https://SERVER/** and sign in as **root** with that password.
If omitted, the password defaults to **toor**. Restarts preserve password changes;
new containers initialize from `ROOT_PASSWORD` again. Docker manages the container's environment.

Scripts in `/init` run independently in parallel and may run continuously.
See [startup scripts](docker/init/README.md) and
[Docker configuration](docs/guide.md#docker).

## Native Linux

Requires Go 1.26.3+, Node.js 22+, a C compiler and PAM development headers.

```sh
npm ci
npm run build
go build -trimpath -o bin/tuxee ./cmd/tuxee
sudo ./bin/tuxee serve --bind :443
```

Sign in with an existing Linux account. Native mode manages the host.
Public certificates require a reachable public port 443; private addresses use
a local CA. See [HTTPS setup](docs/guide.md#https).

## Documentation

- [User and developer guide](docs/guide.md)
- [Product specification](docs/SPEC.md)
- [Example configuration](docker/tuxee.example.json)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

Prototype; not yet production-reviewed.
