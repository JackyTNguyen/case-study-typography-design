// Errors the frontend knows how to present as a retry state.
class AppError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
module.exports = { AppError };
