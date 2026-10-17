import { Editor, Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import HardBreak from '@tiptap/extension-hard-break';
import Bold from '@tiptap/extension-bold';
import Underline from '@tiptap/extension-underline';
import { UndoRedo } from '@tiptap/extensions/undo-redo';
import { Plugin } from '@tiptap/pm/state';
import { plainPasteTransaction } from './plain-paste.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const fromPlain = value => ({version:1, doc:{type:'doc',content:String(value || '').replace(/\r\n?/g,'\n').split('\n').map(line=>({type:'paragraph',...(line ? {content:[{type:'text',text:line}]} : {})}))}});
const read = (value, plain='') => value ? (typeof value === 'string' ? JSON.parse(value) : value) : fromPlain(plain);
const plainText = doc => doc.content.map(p => (p.content || []).map(n=>n.type==='hardBreak'?'\n':n.text || '').join('')).join('\n');
function serialize(doc) {
  if (!plainText(doc).trim()) doc = fromPlain('').doc;
  return JSON.stringify({version:1,doc:{type:'doc',content:doc.content.map(p=>({type:'paragraph',...(p.content?.length ? {content:p.content.map(n=>n.type==='hardBreak'?{type:'hardBreak'}:{type:'text',text:n.text,...(n.marks?.length?{marks:[...n.marks].map(m=>({type:m.type})).sort((a,b)=>a.type.localeCompare(b.type))}:{})})}: {})}))}});
}
function render(value, plain='') {
  const {doc} = read(value, plain);
  return doc.content.map(p => '<p>' + (p.content || []).map(n => {
    if (n.type === 'hardBreak') return '<br>';
    let text = escape(n.text || '');
    if (n.marks?.some(m=>m.type==='bold')) text = '<strong>'+text+'</strong>';
    if (n.marks?.some(m=>m.type==='underline')) text = '<u>'+text+'</u>';
    return text;
  }).join('') + (p.content?.length ? '' : '<br>') + '</p>').join('');
}

function create(target, value, options) {
  let disposed = false;
  let composing = false;
  let lastPublished = serialize(read(value).doc);
  const menu = document.createElement('div');
  menu.className = 'rich-text-menu';
  menu.setAttribute('role','toolbar');
  menu.setAttribute('aria-label','文字の書式');
  menu.hidden = true;
  menu.innerHTML = '<button type="button" data-mark="bold" aria-label="太字" title="太字 (Ctrl+B)" aria-pressed="false"><strong>B</strong></button><button type="button" data-mark="underline" aria-label="下線" title="下線 (Ctrl+U)" aria-pressed="false"><u>U</u></button>';
  document.body.append(menu);
  const Limits = Extension.create({
    name:'limitedText',
    addProseMirrorPlugins() { return [new Plugin({filterTransaction: tr => {
      if (!tr.docChanged) return true;
      const text = tr.doc.textBetween(0,tr.doc.content.size,'\n','\n');
      if (Array.from(text).length <= 20000 && tr.doc.nodeSize <= 60000) return true;
      options.onLimit?.(); return false;
    }})]; },
  });
  const publish = () => {
    if (disposed || composing || editor.view.composing) return;
    const doc = editor.getJSON();
    const text = plainText(doc);
    const rich = serialize(doc);
    if (rich !== lastPublished) {
      lastPublished = rich;
      options.onChange(text.trim() ? text : '', rich);
    }
    updateMenu();
  };
  const editor = new Editor({
    element:target, injectCSS:false, enableInputRules:false, enablePasteRules:false,
    extensions:[Document, Paragraph, Text, HardBreak, Bold, Underline, UndoRedo, Limits],
    content:read(value).doc,
    editorProps:{
      attributes:{class:'rich-text-editor',role:'textbox','aria-multiline':'true','aria-label':options.label || '文章編集'},
      handleKeyDown:(_view,event) => {
        if (event.isComposing || composing || event.keyCode===229) return false;
        if (event.key==='Escape') {event.preventDefault();options.onCancel();return true;}
        if (event.key==='Tab') {event.preventDefault();options.onTab(event.shiftKey?-1:1);return true;}
        return false;
      },
      handlePaste:(view,event) => {
        if (!event.clipboardData) return false;
        event.preventDefault();
        view.dispatch(plainPasteTransaction(view.state,event.clipboardData.getData('text/plain')));
        return true;
      },
      handleDrop:(_view,event) => {event.preventDefault();return true;},
    },
    onUpdate:publish,
    onSelectionUpdate:() => updateMenu(),
  });
  const dom = editor.view.dom;
  dom.style.minHeight = `${options.minHeight || 0}px`;
  dom.addEventListener('compositionstart',()=>{composing=true;menu.hidden=true;});
  dom.addEventListener('compositionend',()=>{composing=false;queueMicrotask(publish);});
  // Suppress table's keyboard/click handlers while retaining document save shortcuts.
  dom.addEventListener('click',event=>event.stopPropagation());
  function updateMenu() {
    if (disposed) return;
    const selection = editor.state.selection;
    const anchor = target.closest('.reply-card') || target;
    const rect = anchor.getBoundingClientRect();
    const scrollRect = target.closest('.table-scroll')?.getBoundingClientRect();
    const visible = rect.bottom > (scrollRect?.top || 0) && rect.top < (scrollRect?.bottom || innerHeight);
    menu.hidden = composing || editor.view.composing || selection.empty || !visible;
    if (menu.hidden) return;
    for (const button of menu.querySelectorAll('button')) button.setAttribute('aria-pressed',String(editor.isActive(button.dataset.mark)));
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8,Math.min(rect.left,innerWidth-bounds.width-8))}px`;
    const top = rect.top-bounds.height-7;
    menu.style.top = `${Math.max(8,Math.min(top >= 8 ? top : rect.bottom+7,innerHeight-bounds.height-8))}px`;
  }
  menu.addEventListener('mousedown',event=>event.preventDefault());
  menu.addEventListener('click',event=>{
    const button=event.target.closest('button[data-mark]');
    if (!button || composing || editor.view.composing) return;
    const mark=button.dataset.mark;
    const chain=editor.chain().focus();
    if (editor.isActive(mark)) chain.unsetMark(mark).run(); else chain.setMark(mark).run();
    updateMenu();
  });
  window.addEventListener('resize',updateMenu);
  document.addEventListener('scroll',updateMenu,true);
  function positionAt(x,y) {
    const r=dom.getBoundingClientRect(),style=getComputedStyle(dom);
    const left=r.left+(parseFloat(style.paddingLeft)||0),right=r.right-(parseFloat(style.paddingRight)||0);
    const top=r.top+(parseFloat(style.paddingTop)||0);
    return editor.view.posAtCoords({left:Math.max(left+1,Math.min(x,right-1)),top:Math.max(top+1,Math.min(y,r.bottom-1))})?.pos ?? (y<top ? 1 : editor.state.doc.content.size-1);
  }
  return {
    editor,dom,menu,positionAt,reposition:updateMenu,
    select(anchor,head=anchor) {editor.commands.setTextSelection({from:anchor,to:head});editor.view.focus();updateMenu();},
    focusEnd() {editor.commands.focus('end');},
    flush:publish,
    destroy() {disposed=true;window.removeEventListener('resize',updateMenu);document.removeEventListener('scroll',updateMenu,true);menu.remove();editor.destroy();},
  };
}
window.NippoRichText = {fromPlain,read,render,serialize,plainText,create};
