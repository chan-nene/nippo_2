// Author-owned conversation drafts and message/reaction presentation.
const CONVERSATION_REACTIONS = {like:['👍','いいね'],understood:['🫡','了解'],cry:['😢','悲しい'],bow:['🙇','ありがとう']};
function messageKey(message) { return `${message.author_employee_id}|${message.message_id}`; }
function conversationDraftKey(op) {
  return `${op.subordinate_employee_id}|${op.date}|${op.superior_employee_id}|${op.action==='react' ? `reaction|${op.target_author_employee_id}|${op.target_message_id}` : `message|${op.message_id}`}`;
}
function conversationMessage(rowIndex, commentIndex, field) {
  return state.rows[Number(rowIndex)]?.comments?.[Number(commentIndex)]?.messages?.find(m=>messageKey(m)===field);
}
function syncConversationInitial(cell) {
  const first=cell.messages?.find(m=>m.message_kind==='initial_comment' && !m.deleted_at);
  cell.comment=first && !first.deleted_at ? first.message_text : '';
  cell.comment_rich_text=first && !first.deleted_at ? first.message_rich_text : plainRichText('');
}
function hydrateConversations() {
  for(const row of state.rows) {
    const data=JSON.parse(row.conversation_data || '{}');
    for(const cell of row.comments || []) { cell.messages=data[cell.superior_employee_id] || []; syncConversationInitial(cell); }
  }
}
function conversationBase(row,cell) { return {subordinate_employee_id:row.employee_id,superior_employee_id:cell.superior_employee_id,date:row.date}; }
function canParticipate(row,cell) { return cell.applies!==false && cell.available!==false && (row.can_edit_report || cell.editable); }
function messageOperation(row,cell,message,action) {
  return {...conversationBase(row,cell),action,message_id:message.message_id,message_kind:message.message_kind,
    ...(action==='delete' ? {} : {message_text:message.message_text,message_rich_text:message.message_rich_text}),
    ...(action==='create' ? {created_at:message.created_at} : {})};
}
function recordMessageChange(row,cell,message,text,rich) {
  message.message_text=text;message.message_rich_text=rich;
  const action=message.is_new?'create':text.trim()?'edit':'delete';
  const op=messageOperation(row,cell,message,action);
  if(message.is_new && !text.trim())state.conversationChanges.delete(conversationDraftKey(op));
  else state.conversationChanges.set(conversationDraftKey(op),op);
  syncConversationInitial(cell);
}
function discardEmptyNewReply(element) {
  if (element.dataset.kind !== 'message') return;
  const {row:ri,comment:ci,field}=element.dataset;
  const row=state.rows[Number(ri)],cell=row?.comments?.[Number(ci)];
  const message=conversationMessage(ri,ci,field);
  if (!message?.is_new || message.message_kind !== 'reply' || message.message_text.trim()) return;
  state.conversationChanges.delete(conversationDraftKey(messageOperation(row,cell,message,'create')));
  cell.messages.splice(cell.messages.indexOf(message),1);
  element.closest('.conversation-card')?.remove();
}
function reapplyConversationDrafts() {
  for(const op of state.conversationChanges.values()) {
    const row=state.rows.find(r=>r.employee_id===op.subordinate_employee_id && r.date===op.date);
    const cell=row?.comments?.find(c=>c.superior_employee_id===op.superior_employee_id);
    if(!cell || cell.applies===false || cell.available===false)continue;
    cell.messages ||= [];
    if(op.action==='react') {
      const m=cell.messages.find(m=>m.author_employee_id===op.target_author_employee_id && m.message_id===op.target_message_id);
      if(m && !m.deleted_at)m.reaction_type=op.reaction_type;
    } else {
      let m=cell.messages.find(m=>m.author_employee_id===state.employeeId && m.message_id===op.message_id);
      if(!m && op.action==='create') { m={author_employee_id:state.employeeId,message_id:op.message_id,message_kind:op.message_kind,created_at:op.created_at,updated_at:op.created_at,deleted_at:'',reaction_type:'',is_new:true};cell.messages.push(m); }
      if(m) {if(op.action==='delete'){m.message_text='';m.message_rich_text=plainRichText('');}else Object.assign(m,{message_text:op.message_text,message_rich_text:op.message_rich_text});}
    }
    syncConversationInitial(cell);
  }
}
function newConversationMessage(kind) {
  const stamp=new Date().toISOString();
  return {message_id:crypto.randomUUID(),author_employee_id:state.employeeId,message_kind:kind,message_text:'',message_rich_text:plainRichText(''),created_at:stamp,updated_at:stamp,deleted_at:'',reaction_type:'',is_new:true};
}
function isSavedConversationMessage(message) {
  return message.saved_present ?? (!message.is_new && !message.deleted_at);
}
function canAppendConversationReply(cell) {
  return Boolean(cell.messages?.some(m=>isSavedConversationMessage(m)));
}
function canSignConversation(cell) {
  const initial=cell.messages?.find(m=>m.message_kind==='initial_comment' && !m.deleted_at);
  return cell.editable && !canAppendConversationReply(cell) && !initial?.message_text.trim();
}
// Reconcile the submitted operation with edits made while the request was in flight.
// saved_present describes persisted existence, independently of the current draft body.
function commitSavedConversationOperation(op) {
  const key=conversationDraftKey(op);
  const pending=state.conversationChanges.get(key);
  const row=state.rows.find(r=>r.employee_id===op.subordinate_employee_id && r.date===op.date);
  const cell=row?.comments?.find(c=>c.superior_employee_id===op.superior_employee_id);
  const unchanged=JSON.stringify(pending)===JSON.stringify(op);
  if(unchanged)state.conversationChanges.delete(key);
  if(!cell || op.action==='react')return;
  let message=cell.messages?.find(m=>m.author_employee_id===state.employeeId && m.message_id===op.message_id);
  if(!message && op.action==='create') {
    // An emptied new reply may already have been removed from the rendered draft.
    message={message_id:op.message_id,message_kind:op.message_kind,created_at:op.created_at,author_employee_id:state.employeeId,message_text:'',message_rich_text:plainRichText(''),deleted_at:'',reaction_type:''};
    (cell.messages ||= []).push(message);
  }
  if(!message)return;
  message.saved_present=op.action!=='delete';
  message.is_new=false;
  if(op.action==='delete') {
    // A deleted UUID cannot be edited: preserve newer text as a fresh message.
    if(!unchanged && pending?.message_text?.trim()) {
      const replacement={...newConversationMessage(message.message_kind),message_text:pending.message_text,message_rich_text:pending.message_rich_text};
      cell.messages.push(replacement);
      const create=messageOperation(row,cell,replacement,'create');
      state.conversationChanges.set(conversationDraftKey(create),create);
    }
    state.conversationChanges.delete(key);
    message.deleted_at ||= new Date().toISOString();
  } else if(op.action==='create' && !unchanged) {
    // Clearing a new message during save becomes a pending deletion once created.
    const next=messageOperation(row,cell,message,pending?.message_text?.trim()?'edit':'delete');
    state.conversationChanges.set(key,next);
  }
  syncConversationInitial(cell);
}
function renderConversationCell(row,cell,rowIndex,commentIndex) {
  const messages=cell.messages ||= [];
  let initial=messages.find(m=>m.message_kind==='initial_comment' && !m.deleted_at);
  if(!initial && cell.editable) { initial=newConversationMessage('initial_comment');messages.unshift(initial); }
  const attrs=`data-row="${rowIndex}" data-comment="${commentIndex}"`;
  const initialHtml=initial ? renderConversationMessage(row,cell,initial,rowIndex,commentIndex) : '';
  const sign=initial && canSignConversation(cell)
    ? `<div class="cell-frame boss-comment-actions"><button class="boss-comment-link" type="button" data-conversation-action="sign" ${attrs} aria-label="サインを記入" title="サインを記入">サイン</button></div>` : '';
  const replies=messages.filter(m=>m.message_kind==='reply').map(m=>renderConversationMessage(row,cell,m,rowIndex,commentIndex)).join('');
  const add=canAppendConversationReply(cell) && canParticipate(row,cell)
    ? `<div class="reply-section is-collapsed">${renderReplyToggleButtonMarkup(rowIndex,commentIndex).replace('data-action="toggle-reply"','data-conversation-action="reply"')}</div>` : '';
  return `<td class="comment-col"><div class="comment-stack">${sign}${initialHtml}${replies}${add}</div></td>`;
}
function isConversationMessageDirty(row,cell,message) {
  const edit=messageOperation(row,cell,message,message.is_new?'create':'edit');
  const reaction={...conversationBase(row,cell),action:'react',target_author_employee_id:message.author_employee_id,target_message_id:message.message_id};
  return state.conversationChanges.has(conversationDraftKey(edit)) || state.conversationChanges.has(conversationDraftKey(reaction));
}
function renderConversationMessage(row,cell,message,rowIndex,commentIndex) {
  if (message.deleted_at) return '';
  const own=message.author_employee_id===state.employeeId;
  const initial=message.message_kind==='initial_comment';
  const editable=own && canParticipate(row,cell) && !message.deleted_at;
  const field=messageKey(message);
  const attrs=`data-row="${rowIndex}" data-comment="${commentIndex}" data-message="${escapeHtml(field)}"`;
  const dirty=isConversationMessageDirty(row,cell,message);
  const authorName=message.author_employee_id===cell.superior_employee_id ? cell.superior_name : row.display_name;
  const content=renderEditableCell({kind:'message',type:initial?'boss':'reply',field,rowIndex,commentIndex,value:message.message_text,editable,showEmptyIcon:false,dirty,editLabel:`${authorName || ''}のメッセージ`});
  const selected=CONVERSATION_REACTIONS[message.reaction_type];
  // Reactions belong to the other participant in this two-person conversation.
  const reactorIsSubordinate=message.author_employee_id===cell.superior_employee_id;
  const reactorName=reactorIsSubordinate
    ? row.display_name || row.employee_id
    : cell.superior_name || cell.superior_employee_id;
  const reactionLabel=selected ? `${selected[1]}（${reactorName}）` : 'リアクションを追加';
  const canReact=!initial && !own && !message.deleted_at && canParticipate(row,cell);
  const reaction=canReact
    ? `<button class="conversation-reaction-toggle${selected ? ' has-reaction' : ''}" type="button" data-conversation-action="reaction-menu" ${attrs} aria-label="${escapeHtml(selected ? reactionLabel+'：変更・解除' : reactionLabel)}" aria-expanded="false" title="${escapeHtml(reactionLabel)}">${selected?.[0] || '+'}</button>`
    : !initial && selected ? `<span class="conversation-reaction-badge" title="${escapeHtml(reactionLabel)}" aria-label="${escapeHtml(reactionLabel)}">${selected[0]}</span>` : '';
  const header=initial ? '' : `<div class="conversation-card-header"><span class="conversation-author" title="${escapeHtml(authorName || message.author_employee_id)}">${escapeHtml(authorName || message.author_employee_id)}</span>${reaction}</div>`;
  return `<div class="conversation-card ${initial?'conversation-initial':'cell-frame reply-card'} ${own?'is-own':'is-partner'} ${message.author_employee_id===cell.superior_employee_id?'is-superior':'is-subordinate'} ${dirty?'is-dirty':''}" ${attrs} tabindex="0">${header}${content}</div>`;
}
function handleConversationAction(button) {
  if(state.isBusy)return;
  if(button.dataset.conversationAction==='reaction-menu') { toggleConversationMenu(button);return; }
  finishEditing();hideConversationMenu();
  const ri=Number(button.dataset.row),ci=Number(button.dataset.comment);
  const row=state.rows[ri],cell=row?.comments?.[ci];
  if(!row || !cell || !canParticipate(row,cell))return;
  const action=button.dataset.conversationAction;
  if(['sign','reply'].includes(action)) {
    const first=cell.messages?.find(m=>m.message_kind==='initial_comment' && !m.deleted_at);
    if(action==='reply' ? !canAppendConversationReply(cell) : !canSignConversation(cell))return;
    let m;
    if(action==='sign') {
      m=first || newConversationMessage('initial_comment');
      if(!first)(cell.messages ||= []).unshift(m);
      const text=normalizeCellValue(state.commentSignature || cell.superior_name);
      recordMessageChange(row,cell,m,text,plainRichText(text));
    } else {
      m=(cell.messages || []).find(m=>m.message_kind==='reply' && m.is_new && !m.message_text.trim());
      if(!m){m=newConversationMessage('reply');(cell.messages ||= []).push(m);}
    }
    renderTable({preserveScroll:true});syncChrome();
    if(action==='reply') {
      const target=Array.from(document.querySelectorAll('.editable-content[data-kind="message"]')).find(el=>el.dataset.row===String(ri) && el.dataset.comment===String(ci) && el.dataset.field===messageKey(m));
      if(target)startEditingTarget(target,{preventScroll:true});
    }
    return;
  }
  const m=cell.messages?.find(m=>messageKey(m)===button.dataset.message);
  if(!m || m.deleted_at)return;
  if(action==='react' && m.message_kind==='reply' && m.author_employee_id!==state.employeeId) {
    const type=button.dataset.reaction;
    if(!CONVERSATION_REACTIONS[type])return;
    const op={...conversationBase(row,cell),action:'react',target_author_employee_id:m.author_employee_id,target_message_id:m.message_id,reaction_type:m.reaction_type===type?'':type};
    m.reaction_type=op.reaction_type;state.conversationChanges.set(conversationDraftKey(op),op);
  }
  renderTable({preserveScroll:true});syncChrome();
}
let conversationMenu=null, conversationMenuTrigger=null;
function hideConversationMenu() {
  if(conversationMenu)conversationMenu.hidden=true;
  conversationMenuTrigger?.setAttribute('aria-expanded','false');
  conversationMenuTrigger=null;
}
function toggleConversationMenu(button) {
  if(!conversationMenu || state.isBusy)return;
  if(conversationMenuTrigger===button && !conversationMenu.hidden) { hideConversationMenu();return; }
  finishEditing();hideConversationMenu();
  const card=button.closest('.conversation-card');
  const row=state.rows[Number(button.dataset.row)],cell=row?.comments?.[Number(button.dataset.comment)];
  const m=cell?.messages?.find(m=>messageKey(m)===button.dataset.message);
  if(!card || !m || m.message_kind!=='reply' || m.deleted_at || m.author_employee_id===state.employeeId || !canParticipate(row,cell))return;
  conversationMenuTrigger=button;
  const attrs=`data-row="${button.dataset.row}" data-comment="${button.dataset.comment}" data-message="${escapeHtml(button.dataset.message)}"`;
  conversationMenu.innerHTML=Object.entries(CONVERSATION_REACTIONS).map(([key,[icon,label]])=>`<button type="button" data-conversation-action="react" data-reaction="${key}" ${attrs} aria-label="${label}" title="${label}" aria-pressed="${m.reaction_type===key}">${icon}</button>`).join('');
  conversationMenu.hidden=false;button.setAttribute('aria-expanded','true');
  const rect=button.getBoundingClientRect();
  conversationMenu.style.left=`${Math.max(4,Math.min(rect.right-conversationMenu.offsetWidth,innerWidth-conversationMenu.offsetWidth-4))}px`;
  const top=rect.top-conversationMenu.offsetHeight-4;
  conversationMenu.style.top=`${Math.max(4,Math.min(top>=4 ? top : rect.bottom+4,innerHeight-conversationMenu.offsetHeight-4))}px`;
  conversationMenu.querySelector('button')?.focus({preventScroll:true});
}
function setupConversationUi() {
  conversationMenu=document.createElement('div');conversationMenu.className='conversation-float-menu';conversationMenu.hidden=true;conversationMenu.setAttribute('role','group');conversationMenu.setAttribute('aria-label','リアクション');document.body.append(conversationMenu);
  conversationMenu.addEventListener('click',event=>{const button=event.target.closest('button');if(button)handleConversationAction(button);});
  document.addEventListener('pointerdown',event=>{
    if(!conversationMenu.contains(event.target) && !event.target.closest('.conversation-reaction-toggle'))hideConversationMenu();
  });
  document.addEventListener('focusin',event=>{
    if(!conversationMenu.contains(event.target) && event.target!==conversationMenuTrigger)hideConversationMenu();
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape' && !conversationMenu.hidden) {
      const trigger=conversationMenuTrigger;hideConversationMenu();trigger?.focus({preventScroll:true});
    }
  });
  document.addEventListener('scroll',hideConversationMenu,true);window.addEventListener('resize',hideConversationMenu);
}
