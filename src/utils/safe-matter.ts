import grayMatter from 'gray-matter';
import type { GrayMatterFile, GrayMatterOption } from 'gray-matter';

/**
 * gray-matter ships a `js` / `javascript` front-matter engine that `eval`s the
 * block whenever a document opens with `---js`. Much of what this CLI parses
 * (team repo markdown, imported repos, MR text, AI drafts) is not trusted, so
 * every parse goes through this wrapper, which replaces those engines with
 * ones that refuse. YAML (and JSON) front matter parse exactly as before.
 */
function refuseJs(): never {
  throw new Error('JavaScript front matter is not allowed');
}

const DISABLED_ENGINES = { js: refuseJs, javascript: refuseJs };

type Options = GrayMatterOption<string, Options>;

function matter(input: string | { content: string }, options?: Options): GrayMatterFile<string> {
  // Passing options also disables gray-matter's module-level parse cache, which
  // otherwise shares mutable `data` objects between callers.
  return grayMatter(input, {
    ...options,
    engines: { ...options?.engines, ...DISABLED_ENGINES },
  });
}

matter.stringify = (
  file: string | { content: string },
  data: object,
  options?: Options,
): string => grayMatter.stringify(file, data, options);

export type { GrayMatterFile };
export default matter;
