import {AgentInbox,agentIdentity} from './agent-inbox.mjs';
import {AppError} from './domain.mjs';
export function createAgentService({repository,dataPath,now}) {
 const store=()=>AgentInbox.open(dataPath,{now});
 async function recipient(){const inbox=await store(),phone=await inbox.owner();if(!phone)throw new AppError(503,'agent_owner_unavailable');
  const rows=(await repository.recipients()).filter(r=>r.enabled&&r.target_type!=='group'&&r.phone===phone&&r.events?.includes('agent.notice'));
  if(!rows.length)throw new AppError(422,'no_authorized_agent_recipient');if(rows.length!==1)throw new AppError(409,'ambiguous_agent_recipient');return rows[0];
 }
 return {store,recipient,
  async cleanup(){await(await store()).change(()=>{});},
  async arm(input){return(await store()).arm(input,await recipient());},
  async list(input,since){return(await store()).since(input,since,await recipient());},
  async close(input){return(await store()).close(input);},
  async notice(alert){const r=await recipient(),inbox=await store();if(alert.agent_request)await inbox.verify(agentIdentity(alert.agent_request),r);
   await inbox.notice(alert.idempotency_key,alert.agent_project);
   return {...alert,audience:r.audience,agent_recipient_id:r.id};
  },
  async authorizeDelivery(job,r){const current=await recipient();if(current.id!==r.id||job.agent_recipient_id!==r.id)return false;
   if(job.agent_request)await(await store()).verify(job.agent_request,current);return true;
  },
  async bind(job,r,address,id){if(job.agent_request)await(await store()).bind(job.agent_request,r,address,id);}
 };
}
