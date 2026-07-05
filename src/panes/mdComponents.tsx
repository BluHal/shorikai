import React from "react";
import { bus } from "../bus";

// inline code that looks like a path (optionally :line) becomes clickable
const FILE_REF = /^([\w@/][\w@./-]*\.[A-Za-z0-9]{1,8})(?::(\d+))?$/;

let projectRoot = "";
export const setProjectRoot = (root: string) => {
  projectRoot = root;
};

function CodeOrFileRef(props: React.HTMLAttributes<HTMLElement>) {
  const text = String(props.children ?? "");
  const m = !text.includes("\n") ? FILE_REF.exec(text) : null;
  if (m) {
    const path = m[1].startsWith("/") ? m[1] : `${projectRoot}/${m[1]}`;
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
  return <code {...props} />;
}

export const mdComponents = { code: CodeOrFileRef };
