/** An error whose message was written for the person using the page, and never contains a key. Anything else is a fault we log. */
export class ConnectorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorInputError';
  }
}
