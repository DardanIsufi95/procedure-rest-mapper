import type { FastifyRequest, FastifyReply } from 'npm:fastify';
export async function testHook(request: FastifyRequest, reply: FastifyReply) {
	request.requestData.set('testdata', 'world');
}
