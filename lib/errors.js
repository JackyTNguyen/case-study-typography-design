// Errors the kiosk knows how to turn into a friendly retry screen.
class AppError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

module.exports = { AppError };
