import { FastifyReply, FastifyRequest } from 'npm:fastify';
import { HttpError } from '../HttpErrors.ts';

export function errorHandler(error: any, request: FastifyRequest, reply: FastifyReply) {
	if (error?.validation) {
		return reply.status(400).send({
			message: 'Validation error',
			errors: error?.validation,
		});
	}

	if (error instanceof HttpError) {
		return reply.status(error.statusCode).send({
			message: error.message,
		});
	}
	console.error('error', error);
	reply.status(500).send({
		error: 'Internal Server Error',
	});
}
export default errorHandler;
