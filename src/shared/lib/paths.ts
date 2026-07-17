// Last path segment, tolerant of both separators and trailing slashes.
export const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;
