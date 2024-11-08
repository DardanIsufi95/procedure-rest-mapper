import mysql from 'npm:mysql2/promise';
import type { FastifyInstance } from 'npm:fastify';
import fp from 'npm:fastify-plugin';

import config from './config.ts';

declare module 'fastify' {
	export interface FastifyInstance {
		db: mysql.Pool;
	}
}

async function registerDatabase(app: FastifyInstance, options: mysql.PoolOptions) {
	const pool = mysql.createPool(options);
	app.decorate('db', pool);
}

export default fp(registerDatabase);
