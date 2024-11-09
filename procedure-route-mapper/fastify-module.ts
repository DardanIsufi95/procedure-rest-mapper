import type {
	FastifyInstance,
	FastifyPluginOptions,
	FastifyRequest,
	FastifyReply,
	preParsingHookHandler,
	preHandlerHookHandler,
	onRequestHookHandler,
	onSendHookHandler,
	onResponseHookHandler,
	preValidationHookHandler,
	preSerializationHookHandler,
	onTimeoutHookHandler,
	onErrorHookHandler,
	RouteOptions,
} from 'fastify';
import fp from 'fastify-plugin';
import { expandGlob } from 'jsr:@std/fs';
import { join } from '@std/path';

import { RequestContext } from '@fastify/request-context';
import { parse, Spec } from 'comment-parser';
import { z } from 'zod';
import vm from 'node:vm';

import { setAuthContext } from '../auth/authHandler.ts';

import { requireAuth, requireRole, requirePermission } from '../auth/authGuards.ts';

type Procedure = {
	name: string;
	definition: string;
	parameters: string[];
};

type HookModule = {
	onRequest?: onRequestHookHandler;
	preParsing?: preParsingHookHandler;
	preValidation?: preValidationHookHandler;
	preHandler?: preHandlerHookHandler;
	preSerialization?: preSerializationHookHandler;
	onSend?: onSendHookHandler;
	onResponse?: onResponseHookHandler;
	onTimeout?: onTimeoutHookHandler;
	onError?: onErrorHookHandler;
	// Additional hooks can be added here
};

interface ProcedureRouteMapperConfig {
	hooksFolder: string;
	schemaName: string;
	procedureNamePrefix: string;
	guardMap: {
		[name: string]: (params: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	};
}

async function registerProcedureRoutes(app: FastifyInstance, options: ProcedureRouteMapperConfig) {
	if (!app.db) {
		throw new Error('Database connection not found');
	}
	if (!app.requestContext) {
		throw new Error('Request context not found');
	}

	const [rows] = await app.db.query<any>(
		`
	  SELECT
		ROUTINE_NAME AS name,
		ROUTINE_DEFINITION as definition,
		CONCAT(
		  '[',
		  IFNULL(
			GROUP_CONCAT('"' , PARAMETER_NAME , '"' ORDER BY ORDINAL_POSITION SEPARATOR ', '),
			''
		  ),
		  ']'
		) AS parameters
	  FROM
		INFORMATION_SCHEMA.ROUTINES r
	  LEFT JOIN
		INFORMATION_SCHEMA.PARAMETERS p ON
		r.SPECIFIC_NAME = p.SPECIFIC_NAME AND
		r.ROUTINE_SCHEMA = p.SPECIFIC_SCHEMA
	  WHERE
		r.ROUTINE_SCHEMA = ?
		AND r.ROUTINE_TYPE = 'PROCEDURE'
	  GROUP BY
		ROUTINE_NAME;
	  `,
		[options.schemaName]
	);

	const procedures: Procedure[] = new Array(...rows).map((procedure) => {
		return {
			name: procedure.name,
			definition: procedure.definition,
			parameters: JSON.parse(procedure.parameters) as string[],
		};
	});

	const proceduresHooksMap = await loadProcedureHooksMap(options.hooksFolder);

	for (const procedure of procedures) {
		try {
			const hooks = proceduresHooksMap[procedure.name] || {};
			const metadata = parse(procedure.definition).flatMap((block) => block.tags);
			const [method, url] = parseProcedureName(procedure.name, options.procedureNamePrefix);

			console.log(`Registering route: ${method} ${url}`);

			const schema = generateZodSchema(procedure, metadata, new ZodSchemaParser());

			const guards = generateGuards(procedure, metadata, options.guardMap);

			const procedureParamMetadata = getParamMetadata(metadata);

			const routeOptions: RouteOptions = {
				method,
				url,
				preValidation: [setAuthContext, ...guards, ...(hooks.preValidation ? (Array.isArray(hooks.preValidation) ? hooks.preValidation : [hooks.preValidation]) : [])],
				preHandler: hooks.preHandler ? (Array.isArray(hooks.preHandler) ? hooks.preHandler : [hooks.preHandler]) : [],
				onRequest: hooks.onRequest,
				preParsing: hooks.preParsing,
				preSerialization: hooks.preSerialization,
				onSend: hooks.onSend,
				onResponse: hooks.onResponse,
				onTimeout: hooks.onTimeout,
				onError: hooks.onError,
				handler: async (request, reply) => {
					try {
						const procedureParams = procedure.parameters.map((param) => {
							const paramMeta = procedureParamMetadata[param];
							if (!paramMeta) {
								throw new Error(`Parameter metadata not found for parameter: ${param} in procedure: ${procedure.name}`);
							}

							let value;
							switch (paramMeta.getFrom) {
								case 'querystring':
									value = (request.query as any)[paramMeta.alias];
									break;
								case 'params':
									value = (request.params as any)[paramMeta.alias];
									break;
								case 'body':
									value = (request.body as any)[paramMeta.alias];
									break;
								case 'headers':
									value = request.headers[paramMeta.alias];
									break;
								case 'user':
									//@ts-ignore
									value = request.requestContext.get('user')?.[paramMeta.alias];
									break;
								default:
									throw new Error(`Unknown getFrom value: ${paramMeta.getFrom} for parameter: ${param} in procedure: ${procedure.name}`);
							}

							if (value === undefined || value === null) {
								return null;
							}

							if (Array.isArray(value) || typeof value === 'object') {
								return JSON.stringify(value);
							}

							return value;
						});

						const sql = `CALL \`${procedure.name}\`(${procedureParams.map(() => '?').join(', ')})`;
						const dbResponse = await app.db.query(sql, procedureParams);

						const results = dbResponse[0] as any;

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
					} catch (error: any) {
						const errorMessage = `Error in handler for procedure ${procedure.name}: ${error.message}`;
						//app.log.error(errorMessage);
						throw new Error(errorMessage);
					}
				},
				schema,
			};
			app.withTypeProvider().route(routeOptions);
		} catch (error: any) {
			const errorMessage = `Error in procedure ${procedure.name}: ${error.message}`;
			//app.log.error(errorMessage);
			throw new Error(errorMessage);
		}
	}
}

function parseProcedureName(procedureName: string, procedureNamePrefix: string = 'api_') {
	const nameWithoutPrefix = procedureName.replace(procedureNamePrefix, '');
	const [methodPart, ...urlParts] = nameWithoutPrefix.split('_');
	const method = methodPart.toUpperCase();
	const url = urlParts
		.join('_')
		.replace(/__/g, '/')
		.replace(/_/g, '-')
		.replace(/\.(\w+)\./g, ':$1');

	return [method, `/${url}`];
}

function generateZodSchema(procedure: Procedure, metadata: Spec[], parser: ZodSchemaParser) {
	const schema: {
		querystring?: z.ZodObject<any>;
		params?: z.ZodObject<any>;
		body?: z.ZodObject<any>;
		headers?: z.ZodObject<any>;
	} = {};

	for (const tag of metadata) {
		if (tag.tag === 'param') {
			const match = tag.name.match(/(\w+)<(\w+)>/);
			const name = match ? match[1] : tag.name;
			const alias = match ? match[2] : tag.name;

			let schemaPart: z.ZodAny;

			try {
				schemaPart = parser.parse(tag.description);
			} catch (error: any) {
				throw new Error(`Error parsing schema for parameter ${name} in procedure ${procedure.name}: ${error.message}`);
			}

			switch (tag.type) {
				case 'querystring':
				case 'body':
				case 'params':
				case 'headers':
					schema[tag.type] = schema[tag.type] ? schema[tag.type]!.extend({ [alias]: schemaPart }) : z.object({ [alias]: schemaPart });
					break;
				case 'user':
					// Handle 'user' type if needed
					break;
				default:
					throw new Error(`Unknown parameter type: ${tag.type} for parameter: ${name} in procedure: ${procedure.name}`);
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

		// Create a secure context
		const context = vm.createContext(sandbox, {
			name: 'zod-sandbox',
			origin: 'zod-sandbox',
		});

		// Remove dangerous globals
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
		try {
			const script = new vm.Script(string);
			const schema = script.runInContext(this.context);
			return schema;
		} catch (error: any) {
			throw new Error(`Error parsing Zod schema: ${error.message} in schema: ${string}`);
		}
	}
}

function generateGuards(
	procedure: Procedure,
	metadata: Spec[],
	guardMap: {
		[name: string]: (params: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
	}
) {
	return metadata
		.filter((tag) => tag.tag === 'guard')
		.map((guard) => {
			if (!guardMap[guard.name]) {
				throw new Error(`Guard not found: ${guard.name} in procedure: ${procedure.name}`);
			}
			const params = guard.description ? guard.description.split(',').map((param) => param.trim()) : [];
			return guardMap[guard.name](params);
		});
}

function getParamMetadata(metadata: Spec[]) {
	const allowedGetFromValues = ['querystring', 'params', 'body', 'headers', 'user'];
	return metadata.reduce((acc, tag) => {
		if (tag.tag === 'param') {
			const match = tag.name.match(/(\w+)<(\w+)>/);
			const name = match ? match[1] : tag.name;
			const alias = match ? match[2] : tag.name;

			if (!allowedGetFromValues.includes(tag.type)) {
				throw new Error(`Invalid getFrom value: ${tag.type} for parameter: ${name}`);
			}

			acc[name] = {
				name,
				alias,
				getFrom: tag.type,
				description: tag.description,
			};
		}
		return acc;
	}, {} as { [name: string]: { name: string; alias: string; getFrom: string; description: string } });
}

async function loadProcedureHooksMap(hooksFolder: string) {
	const hooks: { [name: string]: HookModule } = {};

	for await (const file of expandGlob(`${join(Deno.cwd(), hooksFolder)}/**/*.ts`)) {
		try {
			const moduleUrl = new URL(`file://${file.path}`);
			const module: HookModule = await import(moduleUrl.href);

			const name = moduleUrl.pathname.split('/').pop()?.replace('.ts', '');
			if (!name) {
				throw new Error(`Cannot determine the module name from file path: ${moduleUrl.pathname}`);
			}

			hooks[name] = module;
		} catch (error: any) {
			throw new Error(`Error loading hook module from file ${file.path}: ${error.message}`);
		}
	}

	return hooks;
}

export default fp(registerProcedureRoutes);
