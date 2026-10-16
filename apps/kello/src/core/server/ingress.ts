/** The deployment remains active for queued work, but another version owns new ingress. */
export class IngressRetiredError extends Error {
  constructor() {
    super("Runtime ingress denied: retired");
    this.name = "IngressRetiredError";
  }
}
