import { FastifyInstance } from 'npm:fastify';
import { ZodTypeProvider } from 'npm:fastify-type-provider-zod';
import { setAuthContext } from './authHandler.ts';
import * as tokensUtils from './tokenUtils.ts';
import { z } from 'npm:zod';

export const RequestTokenFromPasswordSchema = z.object({
	grant_type: z.literal('password'),
	username: z.preprocess((value) => (value ? String(value).replaceAll(/\s/g, '').toLowerCase() : undefined), z.string()),
	password: z.preprocess((value) => (value ? String(value).trim() : undefined), z.string()),
});

export const RequestTokenFromRefreshTokenSchema = z.object({
	grant_type: z.literal('refresh_token'),
	refresh_token: z.string().min(1),
});

export const RequestTokenSchema = z.union([RequestTokenFromPasswordSchema, RequestTokenFromRefreshTokenSchema]);
export async function authRoutes(app: FastifyInstance, options: any) {
	await app.withTypeProvider<ZodTypeProvider>().post('/token', {
		schema: {
			body: RequestTokenFromPasswordSchema,
		},
		handler: async (request, reply) => {
			const body = request.body as z.infer<typeof RequestTokenSchema>;
			console.log(body);
			if (body.grant_type === 'password') {
				const token = await tokensUtils.tokenSign({
					uuid: body.username,
					roles: [body.username.toUpperCase()],
					premissions: [body.username.toUpperCase()],
				});
				return reply.send(token);
			}

			return reply.send({});
		},
	});
}
