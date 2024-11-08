import fastify from 'npm:fastify';
import fastifyRequestContext, { RequestContext } from 'npm:@fastify/request-context';
import { serializerCompiler, validatorCompiler } from 'npm:fastify-type-provider-zod';
import config from './config.ts';
import procedureRouteMapper from './procedure-route-mapper/fastify-module.ts';
import registerDB from './db.ts';
import errorHandler from './middleware/errorHandler.ts';
import { authRoutes } from './auth/authRouter.ts';

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
declare module 'fastify' {
	interface FastifyInstance {
		requestContext: RequestContext;
	}
}

const app = fastify({
	logger: {
		level: 'info',
	},
});

app.register(registerDB, config.database);
app.register(fastifyRequestContext);
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
app.setErrorHandler(errorHandler);
app.register(authRoutes, { prefix: '/auth' });
app.register(procedureRouteMapper);

async function startServer() {
	try {
		await app.listen({
			port: config.serverPort,
			host: '0.0.0.0',
		});
		console.log(`Server is running on port ${config.serverPort}`);
	} catch (err) {
		console.error(err);

		Deno.exit(1);
	}
}
startServer();
