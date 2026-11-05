// Its own module so that lib/alerts.ts can throw it without importing lib/server.ts, which imports the alerts.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
