import type { FastifyRequest, FastifyReply } from 'npm:fastify';
export async function testHook(request: FastifyRequest, reply: FastifyReply) {
	console.log('testssssssssssssssssssssssssssssssssss');
	return reply.send('Hello World');
}
