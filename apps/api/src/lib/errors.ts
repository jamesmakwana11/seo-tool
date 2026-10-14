import { ApiError } from '@sentinel/shared';

export { ApiError };

export const badRequest = (message: string, details?: unknown, code = 'VALIDATION') => new ApiError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue.') => new ApiError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message: string) => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (message: string, code = 'CONFLICT') => new ApiError(409, code, message);
