import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { href } from './util';

/** Turn [[slug]] / [[slug|label]] into in-app links before rendering. */
function wikilinks(md: string) {
  return md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, slug: string, label?: string) => `[${label || slug}](${href({ slug: slug.trim() })})`);
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(u) => u}
        components={{
          a: ({ href: h, children }) =>
            h?.startsWith('#') ? (
              <a href={h} className="wikilink">
                {children}
              </a>
            ) : (
              <a href={h} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {wikilinks(source)}
      </ReactMarkdown>
    </div>
  );
}
