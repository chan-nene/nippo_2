"""Author-owned CSV conversations. No cross-author writes or message revisions."""
from __future__ import annotations
from collections import defaultdict
from datetime import date, datetime, timezone
import json
from uuid import UUID
from app.sqlite_table import Table
from app.rich_text import EMPTY_RICH_TEXT, serialize
from app.security import validate_employee_id, safe_employee_csv_path, RequestValidationError

FIELDS = ['message_id','message_kind','message_text','message_rich_text','target_author_employee_id','target_message_id','reaction_type','created_at','updated_at','deleted_at']
USER_COLUMNS = ['record_type','employee_id','date','business_name','business_name_rich_text','business_detail','business_detail_rich_text','superior_employee_id',*FIELDS]
COMMENT_COLUMNS = ['record_type','superior_employee_id','subordinate_employee_id','date',*FIELDS]
USER_KEYS = ['record_type','employee_id','date','superior_employee_id','message_id','target_author_employee_id','target_message_id']
COMMENT_KEYS = ['record_type','superior_employee_id','subordinate_employee_id','date','message_id','target_author_employee_id','target_message_id']
VIEW_USERS = ['record_type','employee_id','date','business_name','business_name_rich_text','business_detail','business_detail_rich_text','reply_to_employee_id','reply_text','reply_rich_text','updated_at']
VIEW_COMMENTS = ['superior_employee_id','subordinate_employee_id','date','comment','comment_rich_text','updated_at']
REACTIONS = {'like','understood','cry','bow'}

def frame(rows, columns):
    return Table([{k:str(r.get(k,'') or '') for k in columns} for r in rows], columns)

def uuid(value):
    if not isinstance(value,str) or str(UUID(value)) != value or UUID(value).version != 4:
        raise ValueError('メッセージIDはUUID v4が必要です。')
    return value

def day(value):
    if not isinstance(value,str) or date.fromisoformat(value).isoformat()!=value:
        raise ValueError('日付が不正です。')
    return value

def timestamp(value):
    if not isinstance(value,str) or not value or datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is None:
        raise ValueError('日時にはタイムゾーンが必要です。')
    return value

def thread(row, side):
    return (row['employee_id'] if side=='user' else row['subordinate_employee_id'],row['date'],row['superior_employee_id'])

def author(row,side):
    return row['employee_id'] if side=='user' else row['superior_employee_id']

def validate_frame(df, owner, side):
    columns=USER_COLUMNS if side=='user' else COMMENT_COLUMNS
    keys=USER_KEYS if side=='user' else COMMENT_KEYS
    if df.columns != columns: raise ValueError('会話形式のCSV列と一致しません。変換が必要です。')
    if df.has_duplicates(keys): raise ValueError('レコードが重複しています。')
    ids=set(); initials=set()
    for r in df.iter_rows(named=True):
        day(r['date'])
        if author(r,side)!=owner: raise ValueError('投稿者とファイル名が一致しません。')
        kind=r['record_type']
        if kind=='report' and side=='user':
            if any(r[k] for k in ['superior_employee_id',*FIELDS] if k!='updated_at'): raise ValueError('日報行に会話情報があります。')
            for field in ('business_name','business_detail'):
                if serialize(r[field+'_rich_text'])[1]!=r[field]: raise ValueError('日報本文と書式が一致しません。')
            continue
        if kind not in ('message','reaction'): raise ValueError('行種別が不正です。')
        subordinate,_,superior=thread(r,side)
        validate_employee_id(subordinate); validate_employee_id(superior)
        if subordinate==superior: raise ValueError('自分自身との会話は作成できません。')
        if side=='user' and any(r[k] for k in ('business_name','business_name_rich_text','business_detail','business_detail_rich_text')): raise ValueError('会話行に日報本文があります。')
        timestamp(r['created_at']);timestamp(r['updated_at'])
        if kind=='message':
            uuid(r['message_id'])
            if r['message_id'] in ids: raise ValueError('メッセージIDが重複しています。')
            ids.add(r['message_id'])
            if r['message_kind'] not in ('initial_comment','reply') or (side=='user' and r['message_kind']!='reply'): raise ValueError('メッセージ種別が不正です。')
            if r['message_kind']=='initial_comment':
                t=thread(r,side)
                if t in initials: raise ValueError('先頭コメントが重複しています。')
                initials.add(t)
            if any(r[k] for k in ('target_author_employee_id','target_message_id','reaction_type')): raise ValueError('メッセージ行にリアクション情報があります。')
            if serialize(r['message_rich_text'])[1]!=r['message_text'] or not r['message_text'].strip(): raise ValueError('メッセージ本文または書式が不正です。')
            if r['deleted_at']: timestamp(r['deleted_at'])
        else:
            if any(r[k] for k in ('message_id','message_kind','message_text','message_rich_text','deleted_at')): raise ValueError('リアクション行に本文があります。')
            uuid(r['target_message_id']);validate_employee_id(r['target_author_employee_id'])
            if r['reaction_type'] not in REACTIONS: raise ValueError('リアクションが不正です。')
            if r['target_author_employee_id'] != (superior if side=='user' else subordinate): raise ValueError('相手の投稿のみリアクションできます。')

def project_users(df):
    return df.where("record_type = 'report'").ensure_columns(VIEW_USERS)


def project_comments(df):
    return df.where("record_type = 'message' AND message_kind = 'initial_comment'").with_column(
        'comment', "CASE WHEN deleted_at != '' THEN '' ELSE message_text END"
    ).with_column('comment_rich_text',
        "CASE WHEN deleted_at != '' THEN ? ELSE message_rich_text END", (EMPTY_RICH_TEXT,)
    ).select(VIEW_COMMENTS)


def conversation_index(users,comments):
    groups=defaultdict(list); reactions=[]
    for side,df in [('user',users),('comment',comments)]:
        for r in df.iter_rows(named=True):
            if r['record_type']=='report': continue
            if r['record_type']=='reaction': reactions.append((thread(r,side),r));continue
            groups[thread(r,side)].append({k:r[k] for k in ('message_id','message_kind','created_at','updated_at','deleted_at')} | {
                'author_employee_id':author(r,side),'message_text':'' if r['deleted_at'] else r['message_text'],
                'message_rich_text':EMPTY_RICH_TEXT if r['deleted_at'] else r['message_rich_text'],'reaction_type':''})
    for t,items in groups.items():
        items.sort(key=lambda m:(m['message_kind']!='initial_comment',datetime.fromisoformat(m['created_at'].replace('Z','+00:00')),m['author_employee_id'],m['message_id']))
    for t,r in reactions:
        for m in groups.get(t,[]):
            if not m['deleted_at'] and (m['author_employee_id'],m['message_id'])==(r['target_author_employee_id'],r['target_message_id']): m['reaction_type']=r['reaction_type']
    return groups

def validate_operations(value):
    if not isinstance(value,list) or len(value)>2000: raise RequestValidationError('会話更新の件数または形式が不正です。')
    allowed={'action','subordinate_employee_id','superior_employee_id','date','message_id','message_kind','message_text','message_rich_text','created_at','target_author_employee_id','target_message_id','reaction_type'}
    result=[];seen=set()
    try:
        for source in value:
            if not isinstance(source,dict) or set(source)-allowed: raise ValueError('会話更新の項目が不正です。')
            r=dict(source)
            for k in ('subordinate_employee_id','superior_employee_id'): validate_employee_id(r.get(k))
            day(r.get('date'))
            action=r.get('action')
            if action in ('create','edit','delete'):
                uuid(r.get('message_id'))
                if r.get('message_kind') not in ('initial_comment','reply'): raise ValueError('メッセージ種別が不正です。')
                if action!='delete':
                    rich,text=serialize(r.get('message_rich_text'))
                    if not text.strip(): raise ValueError('空のメッセージは保存できません。')
                    if r.get('message_text',text)!=text: raise ValueError('本文と書式が一致しません。')
                    r.update(message_text=text,message_rich_text=rich)
                if action=='create': timestamp(r.get('created_at'))
                key=('message',r['message_id'])
            elif action=='react':
                uuid(r.get('target_message_id'));validate_employee_id(r.get('target_author_employee_id'))
                if r.get('reaction_type') not in REACTIONS|{''}: raise ValueError('リアクションが不正です。')
                key=('reaction',r['target_author_employee_id'],r['target_message_id'])
            else: raise ValueError('会話操作が不正です。')
            if key in seen: raise ValueError('同じ投稿への更新が重複しています。')
            seen.add(key);result.append(r)
    except (ValueError,TypeError,AttributeError) as exc: raise RequestValidationError(str(exc)) from exc
    return result

def save_partition(repo,owner,side,reports,ops,common,expected_revision):
    columns=USER_COLUMNS if side=='user' else COMMENT_COLUMNS
    path=safe_employee_csv_path(repo._report_directory_for_employee(owner,common) if side=='user' else repo.storage_dir('comments'),owner)
    with repo._csv_save_lock(path.with_suffix('.lock'),'CSVが保存中です。もう一度保存してください。'):
        existing=repo.load_report_partition(path,owner) if side=='user' else repo.load_comment_partition(path,None)
        # Report editing retains its existing file revision protection. Conversation operations are last-save-wins.
        if reports and expected_revision != repo.loaded_report_revisions[repo._report_path_key(path)]:
            from app.repository import ReportConflictError
            raise ReportConflictError('日報が更新されています。最新データを取得してください。')
        rows=existing.to_dicts();now=datetime.now(timezone.utc).isoformat(timespec='microseconds')
        for update in reports:
            row=next((r for r in rows if r['record_type']=='report' and r['date']==update['date']),None)
            if row is None:
                row=dict.fromkeys(columns,'');row.update(record_type='report',employee_id=owner,date=update['date'],business_name_rich_text=EMPTY_RICH_TEXT,business_detail_rich_text=EMPTY_RICH_TEXT);rows.append(row)
            row.update({k:v for k,v in update.items() if k in ('business_name','business_detail','business_name_rich_text','business_detail_rich_text')});row['updated_at']=now
        other={}
        def peer_rows(subordinate,superior):
            peer=superior if side=='user' else subordinate
            if peer not in other:
                peer_path=safe_employee_csv_path(repo.storage_dir('comments') if side=='user' else repo._report_directory_for_employee(peer,common),peer)
                other[peer]=(repo.load_comment_partition(peer_path,None) if side=='user' else repo.load_report_partition(peer_path,peer)).to_dicts()
            return other[peer]
        for op in ops:
            sub,sup,daytext=op['subordinate_employee_id'],op['superior_employee_id'],op['date'];t=(sub,daytext,sup)
            peers=peer_rows(sub,sup)
            local=[r for r in rows if r['record_type']!='report' and thread(r,side)==t]
            peer_side='comment' if side=='user' else 'user'
            remote=[r for r in peers if r['record_type']!='report' and thread(r,peer_side)==t]
            initial=next((r for r in [*local,*remote] if r['record_type']=='message' and r['message_kind']=='initial_comment'),None)
            base=dict.fromkeys(columns,'');base.update(date=daytext,superior_employee_id=sup)
            base['employee_id' if side=='user' else 'subordinate_employee_id']=sub
            action=op['action']
            if action=='react':
                target=next((r for r in remote if r['record_type']=='message' and r['message_id']==op['target_message_id'] and author(r,peer_side)==op['target_author_employee_id']),None)
                if target is None or target['deleted_at']: raise ValueError('リアクション対象が存在しないか削除されています。')
                prev=next((r for r in local if r['record_type']=='reaction' and r['target_message_id']==op['target_message_id'] and r['target_author_employee_id']==op['target_author_employee_id']),None)
                if prev: rows.remove(prev)
                if op['reaction_type']:
                    base.update(record_type='reaction',target_author_employee_id=op['target_author_employee_id'],target_message_id=op['target_message_id'],reaction_type=op['reaction_type'],created_at=prev['created_at'] if prev else now,updated_at=now);rows.append(base)
                continue
            existing_message=next((r for r in rows if r['record_type']=='message' and r['message_id']==op['message_id']),None)
            if existing_message and (thread(existing_message,side)!=t or existing_message['message_kind']!=op['message_kind']): raise ValueError('メッセージIDが別の投稿に使用されています。')
            if action=='create':
                if existing_message:
                    if any(existing_message[k]!=op[k] for k in ('message_text','message_rich_text','created_at')) or existing_message['deleted_at']: raise ValueError('同じIDに異なる投稿が保存されています。')
                    continue
                if op['message_kind']=='initial_comment':
                    if side!='comment' or initial: raise ValueError('最初のコメントは上司が1件だけ作成できます。')
                elif initial is None: raise ValueError('最初の上司コメントがありません。')
                base.update(record_type='message',message_id=op['message_id'],message_kind=op['message_kind'],message_text=op['message_text'],message_rich_text=op['message_rich_text'],created_at=op['created_at'],updated_at=op['created_at']);rows.append(base)
            else:
                if not existing_message: raise ValueError('自分の投稿だけ編集・削除できます。')
                if action=='delete':
                    if not existing_message['deleted_at']: existing_message.update(deleted_at=now,updated_at=now)
                else:
                    if existing_message['deleted_at']: raise ValueError('削除済みの投稿は編集できません。')
                    existing_message.update(message_text=op['message_text'],message_rich_text=op['message_rich_text'],updated_at=now)
        output=frame(rows,columns);validate_frame(output,owner,side)
        revision=repo._write_csv_atomically(output,path,'reports' if side=='user' else 'comments')
        stat=path.stat()
        return path,output,revision,(stat.st_size,stat.st_mtime_ns)
