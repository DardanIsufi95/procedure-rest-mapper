import { FastifyReply, FastifyRequest } from 'npm:fastify';
import { HttpError } from '../HttpErrors.ts';

export function errorHandler(error: any, request: FastifyRequest, reply: FastifyReply) {
	console.error('error', error);
	if (error?.validation) {
		return reply.status(400).send({
			error: true,
			code: 'VALIDATION_ERROR',
			type: 'FIELD',
			errors: error?.validation.map((validation: any) => {
				return {
					...validation.params.issue,
					validationContext: error.validationContext,
				};
			}),
		});
	}

	if (error.sqlState) {
		if (error.sqlState.startsWith('45')) {
			const errorParts = error.message.split('|');

			const statusCode = Number(errorParts[0]);
			const type = errorParts[1].toUpperCase();

			if (type === 'GENERAL') {
				return reply.status(Number(statusCode)).send({
					error: true,
					code: errorParts[2].toUpperCase(),
					type: type,
					message: errorParts[3],
				});
			}

			if (type === 'FIELD') {
				return reply.status(Number(statusCode)).send({
					error: true,
					code: 'INTERNAL_VALIDATION_ERROR',
					type: type,
					errors: [
						{
							code: errorParts[3].toUpperCase(),
							path: errorParts[2].split('.'),
							message: errorParts[4],
						},
					],
				});
			}

			return reply.status(Number(statusCode)).send({
				error: true,
				type: type.toUpperCase(),
				code: code.toUpperCase(),
				message: message,
				errors:
					type.toUpperCase() == 'FIELD'
						? [
								{
									code: code.toUpperCase(),
								},
						  ]
						: undefined,
			});
		}
	}

	if (error instanceof HttpError) {
		return reply.status(error.statusCode).send({
			error: true,
			type: 'GENERAL',
			message: error.message,
		});
	}

	reply.status(500).send({
		error: true,
		type: 'GENERAL',
		code: 'INTERNAL_SERVER_ERROR',
		message: 'Internal Server Error',
	});
}
export default errorHandler;
