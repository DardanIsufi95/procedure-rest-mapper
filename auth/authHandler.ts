import { FastifyInstance, FastifyRequest, FastifyRequestContext } from 'npm:fastify';
import type { JwtPayload } from 'npm:jsonwebtoken';
import { verify, verifySafe } from './tokenUtils.ts';

import { HttpError, Forbidden, Unauthorized } from '../HttpErrors.ts';

import { RequestContext } from 'npm:@fastify/request-context';

export class AuthError extends HttpError {
	data: any;
	constructor(data?: any) {
		super(401, 'Not authorized');
		this.name = 'AuthError';
		this.data = data;
	}
}

declare module 'npm:fastify' {
	interface FastifyInstance {
		requestContext: RequestContext;
	}
}
declare module '@fastify/request-context' {
	interface RequestContextData {
		token: string | null;
		isAuthenticated: boolean;
		isAuthorised: boolean;
		user: {
			id: string;
			username: string;
			departmentId: string;
			iat: number;
			exp: number;
		} | null;
	}
}

export async function setAuthContext(request: FastifyRequest, reply: any) {
	const token = request.headers.authorization?.split(' ')[1] || '';

	let tokenData: JwtPayload | null = null;
	let isAuthorised = false;
	let isAuthenticated = false;

	try {
		const decoded = verifySafe(token);

		tokenData = decoded?.data || null;
		isAuthenticated = !!decoded;
		isAuthorised = !!decoded && !Boolean(decoded.isExpired);

		//console.log('tokenData', decoded);
	} catch (error) {
		//console.error(error)
	}

	//@ts-ignore
	request.requestContext.set('token', token);
	//@ts-ignore
	request.requestContext.set('user', tokenData as any);
	//@ts-ignore
	request.requestContext.set('isAuthenticated', isAuthenticated);
	//@ts-ignore
	request.requestContext.set('isAuthorised', isAuthorised);
}
