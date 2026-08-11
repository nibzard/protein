export class ProteinError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProteinError";
  }
}

export class ProteinConflictError extends ProteinError {
  constructor(message: string) {
    super(message, "conflict");
    this.name = "ProteinConflictError";
  }
}

export class ProteinValidationError extends ProteinError {
  constructor(message: string) {
    super(message, "validation_error");
    this.name = "ProteinValidationError";
  }
}
