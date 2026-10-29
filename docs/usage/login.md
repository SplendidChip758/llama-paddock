# Login

- `PADDOCK_USERNAME` / `PADDOCK_PASSWORD` set the **initial** login. The first sign-in requires choosing a new password, which is stored hashed (scrypt) in `auth.json` in the data directory. After that the env values are ignored.
- If `PADDOCK_PASSWORD` is empty, a random one is printed to the log on first start.
- Change it later from the account menu (top right). Changing it signs out other sessions. Five wrong attempts lock that address out for 5 minutes.
- **Forgot the password:** delete `auth.json` from the data directory (`/var/lib/llama-paddock`, or the Docker volume) and restart. The login is recreated from the env values.
- `PADDOCK_AUTH=off` disables the login, e.g. when a reverse proxy with auth already sits in front of it. `/api/healthz` stays open for health checks.
