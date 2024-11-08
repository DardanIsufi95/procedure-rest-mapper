// HttpErrors.ts

export class HttpError extends Error {
	public statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
		this.message = message;
		this.name = this.constructor.name;
		Error.captureStackTrace(this, this.constructor);
	}
}

// Specific HTTP Error Classes
export class BadRequest extends HttpError {
	constructor(message: string = 'Bad Request') {
		super(400, message);
	}
}

export class Unauthorized extends HttpError {
	constructor(message: string = 'Unauthorized') {
		super(401, message);
	}
}

export class Forbidden extends HttpError {
	constructor(message: string = 'Forbidden') {
		super(403, message);
	}
}

export class NotFound extends HttpError {
	constructor(message: string = 'Not Found') {
		super(404, message);
	}
}

export class MethodNotAllowed extends HttpError {
	constructor(message: string = 'Method Not Allowed') {
		super(405, message);
	}
}

export class NotAcceptable extends HttpError {
	constructor(message: string = 'Not Acceptable') {
		super(406, message);
	}
}

export class Conflict extends HttpError {
	constructor(message: string = 'Conflict') {
		super(409, message);
	}
}

export class Gone extends HttpError {
	constructor(message: string = 'Gone') {
		super(410, message);
	}
}

export class UnprocessableEntity extends HttpError {
	constructor(message: string = 'Unprocessable Entity') {
		super(422, message);
	}
}

export class TooManyRequests extends HttpError {
	constructor(message: string = 'Too Many Requests') {
		super(429, message);
	}
}

export class InternalServerError extends HttpError {
	constructor(message: string = 'Internal Server Error') {
		super(500, message);
	}
}

export class NotImplemented extends HttpError {
	constructor(message: string = 'Not Implemented') {
		super(501, message);
	}
}

export class BadGateway extends HttpError {
	constructor(message: string = 'Bad Gateway') {
		super(502, message);
	}
}

export class ServiceUnavailable extends HttpError {
	constructor(message: string = 'Service Unavailable') {
		super(503, message);
	}
}

export class GatewayTimeout extends HttpError {
	constructor(message: string = 'Gateway Timeout') {
		super(504, message);
	}
}
