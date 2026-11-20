import { createContext, useContext } from 'react';

/** The tags you've added by hand to any note ("inspiring"), as opposed to the model's. */
export const MyTagsContext = createContext<Set<string>>(new Set());
export const useMyTags = () => useContext(MyTagsContext);
