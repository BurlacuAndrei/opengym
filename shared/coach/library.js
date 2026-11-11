import libraryData from './library.json' with { type: 'json' };

export const LIBRARY = libraryData.exercises;
export const LIB_BY_ID = new Map(LIBRARY.map(e => [e.id, e]));
export const libraryHas = id => LIB_BY_ID.has(id);
export const libraryName = id => LIB_BY_ID.get(id)?.n || null;

export default LIBRARY;
