import { FastifyInstance, FastifyRequest, FastifyRequestContext } from 'npm:fastify';
import { HttpError, Forbidden, Unauthorized } from '../HttpErrors.ts';

export const requireAuth = () => async (request: FastifyRequest, reply: any) => {
	//@ts-ignore
	console.log('requireAuth', request.requestContext.get('isAuthenticated'), request.requestContext.get('isAuthorised'));

	//@ts-ignore
	if (!request.requestContext.get('isAuthenticated')) {
		throw new Forbidden();
	}

	//@ts-ignore
	if (!request.requestContext.get('isAuthorised')) {
		throw new Unauthorized();
	}
};

export const requireRole = (role: string | string[]) => async (request: FastifyRequest, reply: any) => {
	//@ts-ignore
	const userRoles = request.requestContext.get('user')?.roles || [];
	const roles = Array.isArray(role) ? role : [role];

	if (!roles.some((role) => userRoles.includes(role))) {
		throw new Unauthorized();
	}
};

export const requirePermission = (permission: string | string[]) => async (request: FastifyRequest, reply: any) => {
	//@ts-ignore
	const userPermissions = request.requestContext.get('user')?.permissions || [];
	const permissions = Array.isArray(permission) ? permission : [permission];

	if (!permissions.some((permission) => userPermissions.includes(permission))) {
		throw new Unauthorized();
	}
};
