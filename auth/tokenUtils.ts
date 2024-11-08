import * as JWT from 'npm:jsonwebtoken';

import config from '../config.ts';

const { verify: verifyJWT, sign: signJWT } = JWT;
type TokenData = {
	uuid: string;
	roles?: string[];
	premissions?: string[];
};
type DecodedTokenData = TokenData & {
	iat: number;
	exp: number;
};

type RefreshTokenData = {
	id: string;
};
console.log('expires', config.jwt.expiresIn);
function verifyOnly(token: string): boolean {
	try {
		verifyJWT(token, config.jwt.secret);
		return true;
	} catch (error) {
		return false;
	}
}

function verifySafe(token: string): { data: DecodedTokenData; isExpired: boolean } | null {
	try {
		const data = verifyJWT(token, config.jwt.secret, {
			ignoreExpiration: true,
		}) as DecodedTokenData;

		return {
			data,
			isExpired: Date.now() >= data.exp * 1000,
		};
	} catch (error) {
		return null;
	}
}
function verify(token: string): TokenData | null {
	try {
		return verifyJWT(token, config.jwt.secret) as TokenData;
	} catch (error) {
		return null;
	}
}

function tokenSign(data: TokenData, opts?: JWT.SignOptions): string {
	const expiresIn = Number(config.jwt.expiresIn); // 15 minutes
	const expiresAt = new Date(Date.now() + expiresIn * 1000);
	return signJWT(data, config.jwt.secret, { expiresIn: expiresIn, ...opts });
}

function refreshVerifySafe(token: string) {
	try {
		return verifyJWT(token, config.jwt.refreshSecret) as RefreshTokenData;
	} catch (error) {
		return null;
	}
}

function refreshVerify(token: string) {
	return verifyJWT(token, config.jwt.refreshSecret) as RefreshTokenData;
}

function refreshSign(data: RefreshTokenData, opts?: JWT.SignOptions): string {
	return signJWT(data, config.jwt.refreshSecret, { expiresIn: config.jwt.refresExpiresIn || '45m', ...opts });
}

export { verifyOnly, verify, tokenSign, refreshVerify, refreshSign, verifySafe, refreshVerifySafe };
export type { TokenData, RefreshTokenData };
