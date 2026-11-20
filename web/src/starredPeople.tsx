import { createContext, useContext } from 'react';
import type { StarredPerson } from '../../shared/types';
import { personKey, withoutInitials } from '../../shared/names';
import { Icon } from './icons';
import { cx } from './util';

export interface StarredPeople {
  list: StarredPerson[];
  isStarred: (name: string) => boolean;
  toggle: (name: string) => void;
}

export const StarredPeopleContext = createContext<StarredPeople>({ list: [], isStarred: () => false, toggle: () => {} });
export const useStarredPeople = () => useContext(StarredPeopleContext);

/** Whether `name` is one of the starred people (same matching as the people graph). */
export function matchesStarred(list: StarredPerson[], name: string) {
  const k = personKey(name);
  if (!k) return false;
  const w = withoutInitials(k);
  return list.some((p) => p.key === k || withoutInitials(p.key) === w);
}

/** A small star that stars or unstars a person. */
export function PersonStar({ name, size = 12 }: { name: string; size?: number }) {
  const { isStarred, toggle } = useStarredPeople();
  const on = isStarred(name);
  return (
    <button
      type="button"
      className={cx('person-star', on && 'on')}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(name);
      }}
      aria-pressed={on}
      aria-label={on ? `Unstar ${name}` : `Star ${name}`}
      title={on ? `Unstar ${name}` : `Star ${name} as worth paying attention to`}
    >
      <Icon name="star" size={size} fill={on} />
    </button>
  );
}
