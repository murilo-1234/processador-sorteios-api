import morgan from 'morgan';

export const httpLogger = morgan(':method :url :status :res[content-length] - :response-time ms');

export const log = (...a) => console.log('[app]', ...a);
export const err = (...a) => console.error('[err]', ...a);

