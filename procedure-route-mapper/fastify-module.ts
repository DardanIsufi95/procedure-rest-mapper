import type { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'npm:fastify';
import fp from 'npm:fastify-plugin';
import { expandGlob } from 'jsr:@std/fs';
import { join } from 'jsr:@std/path';

import { ProcedureRouteMapperConfig } from './interfaces.ts';
import { RequestContext } from 'npm:@fastify/request-context';
import { parse, Spec } from 'npm:comment-parser';
import { z } from 'npm:zod';
import vm from 'node:vm';
import { ZodTypeProvider } from 'npm:fastify-type-provider-zod';

import { setAuthContext } from '../auth/authHandler.ts';

import { requireAuth, requireRole, requirePremission } from '../auth/authGuards.ts';
import { req } from "../../../AppData/Local/deno/npm/registry.npmjs.org/pino-std-serializers/7.0.0/index.d.ts";

type Procedure = {
	name: string;
	definition: string;
	parameters: string[];
};

type HookModule = {
	preHandler?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	onRequest?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	onSend?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	onResponse?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	test: () => void;
};

async function registerProcedureRoutes(app: FastifyInstance, options: ProcedureRouteMapperConfig) {
	if (!app.db) {
		throw new Error('Database connection not found');
	}
	if (!app.requestContext) {
		throw new Error('Request context not found');
	}

	const [rows] = await app.db.query<any>(/*sql*/ `
		SELECT
			ROUTINE_NAME AS name,
			ROUTINE_DEFINITION as definition,
			CONCAT('[', 
				IFNULL(
								
					GROUP_CONCAT('"' , PARAMETER_NAME , '"' ORDER BY ORDINAL_POSITION SEPARATOR ', '),
					'' -- Returns an empty array if there are no parameters
				), 
			']') AS parameters
		FROM
			INFORMATION_SCHEMA.ROUTINES r
		LEFT JOIN
			INFORMATION_SCHEMA.PARAMETERS p
		ON
			r.SPECIFIC_NAME = p.SPECIFIC_NAME
			AND r.ROUTINE_SCHEMA = p.SPECIFIC_SCHEMA
		WHERE
			r.ROUTINE_SCHEMA = 'test'
			AND r.ROUTINE_TYPE = 'PROCEDURE'
		GROUP BY
			ROUTINE_NAME;

	`);

	const procedures: Procedure[] = new Array(...rows).map((procedure) => {
		return {
			name: procedure.name,
			definition: procedure.definition,
			parameters: JSON.parse(procedure.parameters) as string[],
		};
	});

	const proceduresHooksMap = await loadProcedureHooksMap(options.hooksFolder);

	
	console.log(proceduresHooksMap);
	for (const procedure of procedures) {
		const hooks = proceduresHooksMap[procedure.name] || {};
		const metadata = parse(procedure.definition).flatMap((block) => block.tags);
		const [method, url] = parseProcedureName(procedure.name);

		console.log(method, url);
		
		const schema = generateZodSchema(procedure, metadata, new ZodSchemaParser());

		const guards = generateGuards(procedure, metadata, {
			auth: requireAuth,
			role: requireRole,
			premission: requirePremission,
		});

		const procedureParamMetadata = getParamMetadata(metadata);
		console.log(procedureParamMetadata)
		app.addHook('preValidation', setAuthContext);
		app.withTypeProvider<ZodTypeProvider>().route({
			method: method,
			url: url,
			preValidation: [...guards],
			preHandler: hooks.preHandler ? [hooks.preHandler] : undefined,
			handler: async (request, reply) => {
				console.log(procedure.name, procedure.parameters , request.params);
				const procedureParams = procedure.parameters
					.map((param) => {
						switch (procedureParamMetadata[param].getFrom) {
							case 'querystring':
								return (request.query as any)[procedureParamMetadata[param].alias];
							case 'params':
								return (request.params as any)[procedureParamMetadata[param].alias];
							case 'body':
								return (request.body as any)[procedureParamMetadata[param].alias];
							case 'headers':
								return request.headers[procedureParamMetadata[param].alias];
							case 'user':
								return request.requestContext.get('user')?.[procedureParamMetadata[param].alias];
							default:
								return null;
						}
					})
					.map((param) => {
						if (param === undefined || param === null) {
							return null;
						}

						if (Array.isArray(param) || typeof param === 'object') {
							return JSON.stringify(param);
						}

						return param;
					}); // Add validation here
				const sql = `CALL \`${procedure.name}\`(${procedureParams.map(() => '?').join(', ')})`;
				//console.log(sql, procedureParams);
				return await app.db
					.query(sql, procedureParams)
					.then((result) => result[0] as any[][])
					.then((results) => {
						if (!Array.isArray(results)) {
							return {};
						}

						const info = results.pop();

						const resultMetadata = results?.[0]?.[0]?.['#RESULT#'] ? results.shift()?.[0] : null;
						
						if (!resultMetadata) {
							return results;
						}

						reply.status(resultMetadata.status ? resultMetadata.status : resultMetadata.error ? 400 : 200);

						const resultSchema = resultMetadata?.schema?.split(',') as string[] | undefined;

						if (!resultSchema && resultMetadata.error) {
							return {
								error: !!resultMetadata.error,
								success: !!resultMetadata.success,
								message: resultMetadata.message,
							};
						}

						if (!resultSchema && !resultMetadata.error) {
							return results;
						}

						const preparedResult = resultSchema!.map((type, index) => {
							if (type === 'object') {
								return results[index][0];
							} else {
								return results[index];
							}
						});

						if (preparedResult.length === 1) {
							return preparedResult[0];
						} else {
							return preparedResult;
						}
					});
			},
			schema,
		});
	}
}
function parseProcedureName(procedureName: string, prefix: string = 'api_') {
	const nameWithoutPrefix = procedureName.replace(prefix, '');
	const [methodPart, ...urlParts] = nameWithoutPrefix.split('_');
	const method = methodPart.toUpperCase();
	let url = urlParts
		.join('-')
		.replace(/__/g, '/')
		.replace(/\.(\w+)\./g, ':$1');

	return [method, `/${url}`];
}

function generateZodSchema(procedure: Procedure, metadata: Spec[], parser: { parse: (string: string) => z.ZodAny }) {
	const schema = {} as {
		querystring?: z.ZodObject<any>;
		params?: z.ZodObject<any>;
		body?: z.ZodObject<any>;
		headers?: z.ZodObject<any>;
	};

	for (const tag of metadata) {
		if (tag.tag === 'param') {
			const [tagname, name, alias] = tag.name.match(/(\w+)<(\w+)>/) || [tag.name, tag.name, tag.name];
			console.log(tagname, name, alias);
			const schemaPart = parser.parse(tag.description) || z.string();

			switch (tag.type) {
				case 'querystring':
					if (!schema.querystring) {
						schema.querystring = z.object({});
					}
					schema.querystring = schema.querystring.extend({
						[alias]: schemaPart,
					});
					break;
				case 'body':
					if (!schema.body) {
						schema.body = z.object({});
					}
					schema.body = schema.body.extend({
						[alias]: schemaPart,
					});
					break;
				case 'params':
					if (!schema.params) {
						schema.params = z.object({});
					}
					schema.params = schema.params.extend({
						[alias]: schemaPart,
					});
					break;
				case 'headers':
					if (!schema.headers) {
						schema.headers = z.object({});
					}
					schema.headers = schema.headers.extend({
						[alias]: schemaPart,
					});
					break;
				case 'user':
					// Do nothing
					break;
				default:
					console.log(tag);
					throw new Error(`Unknown parameter type: ${tag.type} for parameter: ${tag.name}`);
			}
		}
	}

	return schema;
}

class ZodSchemaParser {
	private context: vm.Context;
	constructor() {
		this.context = this.createRestrictedContext();
	}

	private createRestrictedContext() {
		const sandbox = {
			z: z, // Expose only the 'z' object
		};

		// Remove dangerous globals
		const context = vm.createContext(sandbox, {
			name: 'zod-sandbox',
			origin: 'zod-sandbox',
		});

		// Remove all properties from global
		const unsafeGlobals = [
			'process',
			'require',
			'global',
			'globalThis',
			'module',
			'exports',
			'Buffer',
			'setImmediate',
			'setInterval',
			'setTimeout',
			'clearImmediate',
			'clearInterval',
			'clearTimeout',
		];

		unsafeGlobals.forEach((prop) => {
			vm.runInContext(`delete this.${prop}`, context);
		});

		return context;
	}

	parse(string: string) {
		const script = new vm.Script(string);
		const schema = script.runInContext(this.context);

		return schema;
	}
}

function generateGuards(
	procedure: Procedure,
	metadata: Spec[],
	guardMap: {
		[name: string]: (params: string[]) => (request: FastifyRequest, reply: any) => Promise<void>;
	}
) {
	return metadata
		.filter((tag) => tag.tag === 'guard')
		.map((guard) => {
			if (!guardMap[guard.name]) {
				throw new Error(`Guard not found: ${guard.name}`);
			}
			const paraps = guard.description.split(',').map((param) => param.trim());
			const guardFunction = guardMap[guard.name](paraps);

			return guardFunction;
		});
}

function getParamMetadata(metadata: Spec[]) {
	return metadata.reduce(
		(acc, tag) => {
			if (tag.tag === 'param') {
				const [tagname, name, alias] = tag.name.match(/(\w+)<(\w+)>/) || [tag.name, tag.name, tag.name];

				acc[name] = {
					name: name,
					alias: alias,
					getFrom: tag.type,
					description: tag.description,
				};
			}

			return acc;
		},
		{} as {
			[name: string]: {
				name: string;
				alias: string;
				getFrom: string;
				description: string;
			};
		}
	);
}

async function loadProcedureHooksMap(hhooksFolder: string) {
	const hooks = {} as { [name: string]: HookModule };

	for await (const file of expandGlob(`${join(Deno.cwd(), hhooksFolder)}/**/*.ts`)) {
		const moduleUrl = new URL(`file://${file.path}`);
		const module: HookModule = await import(moduleUrl.href);

		const name = moduleUrl.pathname.split('/').pop()?.replace('.ts', '');

		hooks[name!] = module;
	}

	return hooks;
}

export default fp(registerProcedureRoutes);
