import React from "react";
import { bus } from "../bus";

// inline code that looks like a path (optionally :line) becomes clickable
const FILE_REF = /^([\w@/][\w@./-]*\.[A-Za-z0-9]{1,8})(?::(\d+))?$/;

function CodeOrFileRef(
  props: React.HTMLAttributes<HTMLElement> & { root: string },
) {
  const { root, ...rest } = props;
  const text = String(props.children ?? "");
  const m = !text.includes("\n") ? FILE_REF.exec(text) : null;
  if (m) {
    const path = m[1].startsWith("/") ? m[1] : `${root}/${m[1]}`;
    const line = m[2] ? Number(m[2]) : undefined;
    return (
      <code
        className="chat-file-ref"
        onClick={() => bus.openFile(path, line)}
        title={path}
      >
        {text}
      </code>
    );
  }
  return <code {...rest} />;
}

const cache = new Map<string, { code: React.ComponentType<React.HTMLAttributes<HTMLElement>> }>();

/// stable per-root component map for react-markdown
export function mdComponentsFor(root: string) {
  let entry = cache.get(root);
  if (!entry) {
    entry = {
      code: (props: React.HTMLAttributes<HTMLElement>) => (
        <CodeOrFileRef {...props} root={root} />
      ),
    };
    cache.set(root, entry);
  }
  return entry;
}
