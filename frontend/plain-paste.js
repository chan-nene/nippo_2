import { Fragment, Slice } from '@tiptap/pm/model';

// Insert an inline slice: block insertion would split an ordinary mid-sentence paste.
export function plainPasteTransaction(state, text) {
  const nodes=[];
  text.replace(/\r\n?/g,'\n').split('\n').forEach((line,index)=>{
    if (index) nodes.push(state.schema.nodes.hardBreak.create());
    if (line) nodes.push(state.schema.text(line));
  });
  return state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes),0,0)).setStoredMarks([]).scrollIntoView();
}
