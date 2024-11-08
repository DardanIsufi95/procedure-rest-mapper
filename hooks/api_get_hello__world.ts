import type { FastifyRequest, FastifyReply } from 'npm:fastify';
export async function preHandler(request: FastifyRequest, reply: FastifyReply) {
	console.log('testssssssssssssssssssssssssssssssssss');
	return 'test';
}
