import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
dotenv.config({path:resolve(process.cwd(),'../../.env')});
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { PrismaClient, LoanKind } from '@nivara/database';
import { z } from 'zod';

const db=new PrismaClient(); const app=express(); const google=new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const secret=process.env.JWT_SECRET || 'development-only-change-me';
const vaultPath=resolve(process.cwd(),'../../storage/vault'); mkdirSync(vaultPath,{recursive:true});
const upload=multer({storage:multer.diskStorage({destination:vaultPath,filename:(_req,file,cb)=>cb(null,`${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`)}),limits:{fileSize:10*1024*1024},fileFilter:(_req,file,cb)=>cb(null,['application/pdf','image/jpeg','image/png'].includes(file.mimetype))});
app.use(cors({origin:'http://localhost:5173'})); app.use(express.json());
const tokenFor=(user:{id:string;email:string;name:string})=>jwt.sign({sub:user.id,email:user.email,name:user.name},secret,{expiresIn:'7d'});
const publicUser=(u:{id:string;name:string;email:string;avatarUrl:string|null})=>({id:u.id,name:u.name,email:u.email,avatarUrl:u.avatarUrl});
const auth=z.object({email:z.string().email(),password:z.string().min(8)});

app.get('/api/health',(_,res)=>res.json({ok:true}));
app.post('/api/auth/signup',async(req,res)=>{const data=auth.extend({name:z.string().min(2).max(80)}).parse(req.body);const exists=await db.user.findUnique({where:{email:data.email}});if(exists)return res.status(409).json({message:'An account with this email already exists.'});const user=await db.user.create({data:{name:data.name,email:data.email,passwordHash:await bcrypt.hash(data.password,12)}});res.status(201).json({token:tokenFor(user),user:publicUser(user)})});
app.post('/api/auth/login',async(req,res)=>{const data=auth.parse(req.body);const user=await db.user.findUnique({where:{email:data.email}});if(!user?.passwordHash || !await bcrypt.compare(data.password,user.passwordHash))return res.status(401).json({message:'Email or password is incorrect.'});res.json({token:tokenFor(user),user:publicUser(user)})});
app.post('/api/auth/google',async(req,res)=>{const {credential}=z.object({credential:z.string().min(1)}).parse(req.body);if(!process.env.GOOGLE_CLIENT_ID)return res.status(503).json({message:'Google sign-in has not been configured yet.'});const ticket=await google.verifyIdToken({idToken:credential,audience:process.env.GOOGLE_CLIENT_ID});const p=ticket.getPayload();if(!p?.email || !p.sub)return res.status(401).json({message:'Google could not verify this account.'});const user=await db.user.upsert({where:{email:p.email},update:{googleId:p.sub,name:p.name||p.email,avatarUrl:p.picture},create:{email:p.email,googleId:p.sub,name:p.name||p.email,avatarUrl:p.picture}});res.json({token:tokenFor(user),user:publicUser(user)})});

const loanSchema=z.object({name:z.string().min(2),kind:z.nativeEnum(LoanKind),principal:z.number().positive(),outstanding:z.number().nonnegative(),interestRate:z.number().nonnegative(),termMonths:z.number().int().positive(),emi:z.number().nonnegative().default(0),startDate:z.coerce.date(),paymentDueDay:z.number().int().min(1).max(28).default(5)});
type RecordedPayment={amount:number;date:Date;kind:'EMI'|'EXTRA'|'INTEREST_RENEWAL'};
// The payment amount includes both interest and principal. Rebuilding the balance from
// the payment history keeps the dashboard, calendar, and statement in agreement.
function repaymentProgress(principal:number,interestRate:number,payments:RecordedPayment[]){
  let balance=principal; let principalPaid=0; let interestPaid=0;
  for(const payment of [...payments].sort((a,b)=>a.date.getTime()-b.date.getTime())){
    if(payment.kind==='INTEREST_RENEWAL'){interestPaid+=payment.amount;continue}
    const interest=payment.kind==='EXTRA'?0:Math.round(balance*interestRate/1200);
    const paidInterest=Math.min(payment.amount,interest);
    const paidPrincipal=Math.min(balance,Math.max(0,payment.amount-paidInterest));
    interestPaid+=paidInterest; principalPaid+=paidPrincipal; balance=Math.max(0,balance-paidPrincipal);
  }
  return {balance:Math.round(balance),principalPaid:Math.round(principalPaid),interestPaid:Math.round(interestPaid)};
}
type ScheduledLoan={principal:number;interestRate:number;termMonths:number;emi:number;startDate:Date;payments:RecordedPayment[]};
function scheduledProgress(loan:ScheduledLoan){
  const firstEmi=new Date(loan.startDate); firstEmi.setHours(0,0,0,0);
  const today=new Date(); today.setHours(0,0,0,0);
  let paidEmis=0;
  if(today>=firstEmi){
    paidEmis=(today.getFullYear()-firstEmi.getFullYear())*12+today.getMonth()-firstEmi.getMonth()+1;
    if(today.getDate()<firstEmi.getDate())paidEmis-=1;
  }
  paidEmis=Math.max(0,Math.min(loan.termMonths,paidEmis));
  let balance=loan.principal; let principalPaid=0; let interestPaid=0;
  if(loan.emi>0)for(let index=0;index<paidEmis&&balance>0.5;index++){
    const interest=Math.round(balance*loan.interestRate/1200);const payment=Math.min(loan.emi,balance+interest);const principal=Math.max(0,payment-interest);
    balance=Math.max(0,balance-principal);principalPaid+=principal;interestPaid+=interest;
  }
  const extras=loan.payments.filter(payment=>payment.kind==='EXTRA'&&payment.date<=today).reduce((sum,payment)=>sum+payment.amount,0);
  const extraPrincipal=Math.min(balance,extras);balance=Math.max(0,balance-extraPrincipal);principalPaid+=extraPrincipal;
  return {paidEmis,remainingEmis:Math.max(0,loan.termMonths-paidEmis),principalPaid:Math.round(principalPaid),interestPaid:Math.round(interestPaid),balance:Math.round(balance),recordedEmis:loan.payments.filter(payment=>payment.kind==='EMI').length};
}
function installmentForMonth(loan:ScheduledLoan,year:number,month:number){
  const first=new Date(loan.startDate);first.setHours(0,0,0,0);const index=(year-first.getFullYear())*12+(month-1-first.getMonth());
  if(index<0||index>=loan.termMonths)return null;const date=new Date(first);date.setMonth(first.getMonth()+index);if(date.getFullYear()!==year||date.getMonth()!==month-1)return null;
  if(loan.emi<=0){const interest=Math.round(loan.principal*loan.interestRate/1200);return {date,payment:interest,principal:0,interest,kind:'INTEREST_RENEWAL' as const};}
  let balance=loan.principal;let payment=0;let principal=0;let interest=0;
  for(let step=0;step<=index&&balance>0.5;step++){interest=Math.round(balance*loan.interestRate/1200);payment=Math.min(loan.emi,balance+interest);principal=Math.max(0,payment-interest);balance=Math.max(0,balance-principal);}
  return {date,payment:Math.round(payment),principal:Math.round(principal),interest:Math.round(interest),kind:'EMI' as const};
}
app.get('/api/loans',async(_,res)=>{const loans=await db.loan.findMany({include:{payments:true},orderBy:{createdAt:'desc'}});res.json(loans.map(loan=>{const automaticProgress=scheduledProgress(loan);return {...loan,calculatedOutstanding:automaticProgress.balance,automaticProgress}})) });
app.post('/api/loans',async(req,res)=>res.status(201).json(await db.loan.create({data:loanSchema.parse(req.body)})));
app.put('/api/loans/:id',async(req,res)=>{const existing=await db.loan.findUniqueOrThrow({where:{id:req.params.id},include:{payments:true}});const data=loanSchema.parse(req.body);const outstanding=existing.payments.length?repaymentProgress(data.principal,data.interestRate,existing.payments).balance:data.principal;res.json(await db.loan.update({where:{id:existing.id},data:{...data,outstanding}}))});
app.get('/api/calendar',async(req,res)=>{
  const months=Math.min(Math.max(Number(req.query.months)||3,1),24);
  const now=new Date(); now.setHours(0,0,0,0);
  const end=new Date(now.getFullYear(),now.getMonth()+months,0,23,59,59,999);
  const loans=await db.loan.findMany({include:{payments:true}});
  const events=loans.flatMap(loan=>{
    const items=[] as Array<{id:string;loanId:string;loanName:string;date:string;amount:number;kind:'EMI'|'INTEREST_RENEWAL';status:'paid'|'due'|'upcoming'|'overdue';paymentId:string|null}>;
    const first=new Date(loan.startDate); first.setHours(0,0,0,0);
    for(let index=0;index<loan.termMonths;index++){
      const date=new Date(first); date.setMonth(first.getMonth()+index);
      if(date<now || date>end) continue;
      const interestOnly=loan.emi===0;
      const kind=interestOnly?'INTEREST_RENEWAL':'EMI';
      const amount=interestOnly?Math.round(loan.outstanding*loan.interestRate/1200):loan.emi;
      const payment=loan.payments.find(p=>p.kind===kind&&p.date.getFullYear()===date.getFullYear()&&p.date.getMonth()===date.getMonth());
      const diff=Math.floor((date.getTime()-now.getTime())/86400000);
      items.push({id:`${loan.id}-${date.toISOString().slice(0,7)}`,loanId:loan.id,loanName:loan.name,date:date.toISOString(),amount,kind,status:payment?'paid':diff<0?'overdue':diff<=7?'due':'upcoming',paymentId:payment?.id??null});
    }
    return items;
  }).sort((a,b)=>a.date.localeCompare(b.date));
  res.json({events});
});
app.get('/api/loans/:id/amortization',async(req,res)=>{
  const loan=await db.loan.findUniqueOrThrow({where:{id:req.params.id},include:{payments:true}});
  const progress=scheduledProgress(loan);
  const fullSchedule=String(req.query.full)==='true';
  const months=fullSchedule?loan.termMonths:progress.remainingEmis;
  if(loan.emi<=0){const balance=fullSchedule?loan.principal:progress.balance;const monthlyInterest=Math.round(balance*loan.interestRate/1200);const schedule=Array.from({length:months},(_,index)=>({month:fullSchedule?index+1:progress.paidEmis+index+1,payment:monthlyInterest,principal:0,interest:monthlyInterest,balance}));return res.json({loanId:loan.id,interestOnly:true,monthlyInterest,schedule,fullSchedule,totalMonths:loan.termMonths,completedMonths:progress.paidEmis,remainingMonths:progress.remainingEmis})}
  const monthlyRate=loan.interestRate/1200; let balance=fullSchedule?loan.principal:progress.balance; const schedule=[] as Array<{month:number;payment:number;principal:number;interest:number;balance:number}>;
  for(let month=1;month<=months&&balance>0.5;month++){
    const interest=Math.round(balance*monthlyRate); const payment=Math.min(loan.emi,balance+interest); const principal=Math.max(0,payment-interest); balance=Math.max(0,balance-principal);
    schedule.push({month,payment,principal,interest,balance:Math.round(balance)});
  }
  const totals=schedule.reduce((a,x)=>({interest:a.interest+x.interest,principal:a.principal+x.principal}),{interest:0,principal:0});
  res.json({loanId:loan.id,interestOnly:false,monthlyRate,schedule,totals,fullSchedule,totalMonths:loan.termMonths,completedMonths:progress.paidEmis,remainingMonths:progress.remainingEmis});
});
type PayoffLoan={id:string;name:string;balance:number;rate:number;emi:number;remainingEmis:number};
const payoffTarget=(loans:PayoffLoan[],strategy:'avalanche'|'snowball')=>[...loans].filter(loan=>loan.balance>1).sort((a,b)=>strategy==='avalanche'?b.rate-a.rate:a.balance-b.balance)[0];
function simulatePayoff(source:PayoffLoan[],strategy:'avalanche'|'snowball',extraMonthly=0,oneTime=0){
  const loans=source.map(loan=>({...loan,balance:loan.balance}));const monthlyCommitment=loans.reduce((sum,loan)=>sum+loan.emi,0);let interestPaid=0;let month=0;const closures:Array<{loanId:string;name:string;month:number;freedEmi:number;monthlyPower:number;redirectedTo:string}>=[];
  const recordClosures=()=>{for(const loan of loans.filter(item=>item.balance<=1&&!closures.some(closure=>closure.loanId===item.id))){const next=payoffTarget(loans,strategy);const monthlyPower=extraMonthly+closures.reduce((sum,closure)=>sum+closure.freedEmi,0)+loan.emi;closures.push({loanId:loan.id,name:loan.name,month,freedEmi:Math.round(loan.emi),monthlyPower:Math.round(monthlyPower),redirectedTo:next?.name||'Your debt-free finish'});}};
  if(oneTime>0){const target=payoffTarget(loans,strategy);if(target)target.balance=Math.max(0,target.balance-oneTime);recordClosures();}
  while(loans.some(loan=>loan.balance>1)&&month<600){
    month++;let spent=0;
    for(const loan of loans.filter(item=>item.balance>1)){const interest=loan.balance*loan.rate/1200;interestPaid+=interest;const payment=Math.min(loan.emi,loan.balance+interest);spent+=payment;loan.balance=Math.max(0,loan.balance+interest-payment);}
    const cascadeBudget=Math.max(0,monthlyCommitment+extraMonthly-spent);const target=payoffTarget(loans,strategy);if(target&&cascadeBudget>0)target.balance=Math.max(0,target.balance-cascadeBudget);recordClosures();
  }
  return {strategy,months:month,interestPaid:Math.round(interestPaid),monthlyCommitment:Math.round(monthlyCommitment),closures,unresolvedLoans:loans.filter(loan=>loan.balance>1).map(loan=>loan.name)};
}
app.get('/api/payoff/compare',async(req,res)=>{const extra=Math.max(0,Number(req.query.extraMonthly)||0);const oneTime=Math.max(0,Number(req.query.oneTime)||0);const records=await db.loan.findMany({include:{payments:true}});const startingLoans=records.map(loan=>{const progress=scheduledProgress(loan);return {id:loan.id,name:loan.name,balance:progress.balance,rate:loan.interestRate,emi:loan.emi||Math.ceil(progress.balance*loan.interestRate/1200),remainingEmis:progress.remainingEmis};}).filter(loan=>loan.balance>1);const avalanche=simulatePayoff(startingLoans,'avalanche',extra,oneTime);const snowball=simulatePayoff(startingLoans,'snowball',extra,oneTime);res.json({extraMonthly:extra,oneTime,startingLoans:startingLoans.map(loan=>({...loan,balance:Math.round(loan.balance)})),avalanche,snowball,recommendation:avalanche.interestPaid<=snowball.interestPaid?'avalanche':'snowball',interestSaved:Math.abs(avalanche.interestPaid-snowball.interestPaid),monthsDifference:Math.abs(avalanche.months-snowball.months)});});
const profileSchema=z.object({monthlyIncome:z.number().nonnegative(),essentialExpenses:z.number().nonnegative(),monthlySavings:z.number().nonnegative(),emergencyFund:z.number().nonnegative(),incomeFrequency:z.enum(['WEEKLY','BIWEEKLY','MONTHLY','YEARLY']).default('MONTHLY'),bonusAmount:z.number().nonnegative().default(0),bonusFrequency:z.enum(['NONE','ONE_TIME','MONTHLY','QUARTERLY','YEARLY']).default('NONE')});
app.get('/api/users/:userId/financial-profile',async(req,res)=>{const profile=await db.financialProfile.findUnique({where:{userId:req.params.userId}});res.json({profile})});
app.put('/api/users/:userId/financial-profile',async(req,res)=>{const data=profileSchema.parse(req.body);res.json(await db.financialProfile.upsert({where:{userId:req.params.userId},update:data,create:{userId:req.params.userId,...data}}));});
app.get('/api/users/:userId/affordability',async(req,res)=>{const profile=await db.financialProfile.findUnique({where:{userId:req.params.userId}});if(!profile)return res.json({configured:false});const emi=(await db.loan.aggregate({_sum:{emi:true}}))._sum.emi||0;const available=profile.monthlyIncome-profile.essentialExpenses-profile.monthlySavings-emi;res.json({configured:true,monthlyIncome:profile.monthlyIncome,essentialExpenses:profile.essentialExpenses,monthlySavings:profile.monthlySavings,monthlyEmi:emi,availableForExtraPayment:Math.max(0,available),emiToIncomePercent:profile.monthlyIncome?Math.round(emi/profile.monthlyIncome*100):0,emergencyFundMonths:profile.essentialExpenses?Number((profile.emergencyFund/profile.essentialExpenses).toFixed(1)):0});});
app.get('/api/safeguards',async(_,res)=>{const now=new Date();now.setHours(0,0,0,0);const loans=await db.loan.findMany({where:{kind:{in:[LoanKind.JEWEL,LoanKind.OVERDRAFT]}}});const alerts=loans.map(loan=>{const start=new Date(loan.startDate);const isJewel=loan.kind===LoanKind.JEWEL;const due=isJewel?new Date(start.getFullYear()+1,start.getMonth(),loan.paymentDueDay):new Date(now.getFullYear(),now.getMonth()+1,loan.paymentDueDay);if(!isJewel&&due<now)due.setMonth(due.getMonth()+1);const days=Math.ceil((due.getTime()-now.getTime())/86400000);const amount=Math.round(loan.outstanding*loan.interestRate/(isJewel?100:1200));return {loanId:loan.id,loanName:loan.name,kind:loan.kind,dueDate:due.toISOString(),daysRemaining:days,amount,action:isJewel?'Pay annual interest to renew':'Pay this month’s overdraft interest',severity:days<=7?'critical':days<=30?'warning':'info'};}).sort((a,b)=>a.daysRemaining-b.daysRemaining);res.json({alerts});});
app.get('/api/users/:userId/stress-score',async(req,res)=>{const profile=await db.financialProfile.findUnique({where:{userId:req.params.userId}});const loans=await db.loan.findMany();const emi=loans.reduce((sum,l)=>sum+(l.emi||l.outstanding*l.interestRate/1200),0);const highInterest=loans.filter(l=>l.interestRate>=14).length;const totalBalance=loans.reduce((sum,l)=>sum+l.outstanding,0);if(!profile)return res.json({configured:false,score:null,actions:['Add your income, expenses, savings, and emergency fund to calculate a personal score.']});const ratio=profile.monthlyIncome?emi/profile.monthlyIncome:1;const emergencyMonths=profile.essentialExpenses?profile.emergencyFund/profile.essentialExpenses:0;let score=100;const actions:string[]=[];if(ratio>.5){score-=35;actions.push('EMIs exceed 50% of income—avoid new borrowing and reduce high-interest debt first.')}else if(ratio>.35){score-=18;actions.push('Keep extra payments focused on high-interest loans until EMI pressure falls below 35%.')}else actions.push('Your EMI-to-income ratio is within a manageable range.');if(emergencyMonths<1){score-=18;actions.push('Build a one-month emergency buffer before making aggressive extra payments.')}else if(emergencyMonths<3){score-=8;actions.push('Continue building toward a three-month emergency buffer.')}else actions.push('Your emergency buffer is providing useful stability.');if(highInterest){score-=highInterest*7;actions.push(`Prioritize ${highInterest} high-interest loan${highInterest>1?'s':''} to reduce interest stress.`)}if(totalBalance>profile.monthlyIncome*24){score-=8;actions.push('Your outstanding balance is high relative to income; use the payoff cascade consistently.')}score=Math.max(0,Math.round(score));res.json({configured:true,score,level:score>=75?'steady':score>=50?'watchful':'high pressure',metrics:{emiToIncomePercent:Math.round(ratio*100),emergencyFundMonths:Number(emergencyMonths.toFixed(1)),highInterestLoans:highInterest,totalOutstanding:totalBalance},actions});});
app.get('/api/users/:userId/documents',async(req,res)=>res.json(await db.document.findMany({where:{userId:req.params.userId},orderBy:{createdAt:'desc'}})));
app.post('/api/users/:userId/documents',upload.single('file'),async(req,res)=>{if(!req.file)return res.status(400).json({message:'Upload a PDF, PNG, or JPG file up to 10 MB.'});const loanId=typeof req.body.loanId==='string'?req.body.loanId:null;const document=await db.document.create({data:{userId:String(req.params.userId),loanId,name:req.file.originalname,mimeType:req.file.mimetype,sizeBytes:req.file.size,path:req.file.path}});res.status(201).json(document)});
app.get('/api/reviews/monthly',async(req,res)=>{
  const requested=typeof req.query.month==='string'?req.query.month:undefined;const now=new Date();now.setHours(0,0,0,0);
  const [year,month]=requested?.match(/^\d{4}-\d{2}$/)?requested.split('-').map(Number):[now.getFullYear(),now.getMonth()+1];
  const start=new Date(year,month-1,1);const end=new Date(year,month,1);const loans=await db.loan.findMany({include:{payments:true}});
  const schedule=loans.flatMap(loan=>{const installment=installmentForMonth(loan,year,month);if(!installment)return [];const confirmed=loan.payments.some(payment=>payment.kind===installment.kind&&payment.date.getFullYear()===year&&payment.date.getMonth()===month-1);const counted=installment.date<=now;return [{loanId:loan.id,loanName:loan.name,...installment,status:confirmed?'confirmed':counted?'counted':'upcoming'}];});
  const payments=loans.flatMap(loan=>loan.payments.filter(payment=>payment.date>=start&&payment.date<end).map(payment=>({...payment,loanName:loan.name})));
  const extraPaid=payments.filter(payment=>payment.kind==='EXTRA').reduce((sum,payment)=>sum+payment.amount,0);
  const dueSchedule=schedule.filter(item=>item.date<=now);const confirmedPayments=payments.filter(payment=>payment.kind==='EMI'||payment.kind==='INTEREST_RENEWAL');
  const scheduledAmount=schedule.reduce((sum,item)=>sum+item.payment,0);const scheduledInterest=dueSchedule.reduce((sum,item)=>sum+item.interest,0);const scheduledPrincipal=dueSchedule.reduce((sum,item)=>sum+item.principal,0);
  const active=loans.map(loan=>({loan,balance:scheduledProgress(loan).balance})).filter(item=>item.balance>0).sort((a,b)=>b.loan.interestRate-a.loan.interestRate)[0];
  const confirmedCount=confirmedPayments.length;const countedCount=dueSchedule.length;const futureCount=schedule.length-countedCount;
  const message=!schedule.length?`There are no scheduled loan payments in ${start.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}.`:countedCount?`${countedCount} scheduled payment${countedCount===1?' was':'s were'} counted from your first EMI dates.${confirmedCount?` ${confirmedCount} ${confirmedCount===1?'is':'are'} also confirmed in the calendar.`:' Confirm them in Calendar when you have paid the lender.'}`:`${futureCount} payment${futureCount===1?' is':'s are'} planned later this month.`;
  res.json({month:`${year}-${String(month).padStart(2,'0')}`,scheduledAmount:Math.round(scheduledAmount),scheduledEmis:schedule.length,countedEmis:countedCount,confirmedEmis:confirmedCount,extraPaid:Math.round(extraPaid),estimatedInterestPaid:Math.round(scheduledInterest),debtReduction:Math.round(scheduledPrincipal+extraPaid),nextBestMove:active?`Prioritize ${active.loan.name} at ${active.loan.interestRate}% interest.`:'Add your first loan to create a tailored next step.',message,schedule:schedule.map(item=>({...item,date:item.date.toISOString()}))});
});
const csv=(headers:string[],rows:Array<Array<string|number|Date|null>>)=>[headers.join(','),...rows.map(row=>row.map(x=>`"${String(x??'').replace(/"/g,'""')}"`).join(','))].join('\n');
app.get('/api/exports/loans.csv',async(_req,res)=>{const loans=await db.loan.findMany({include:{payments:true}});res.type('text/csv').attachment('nivara-loans.csv').send(csv(['Name','Type','Principal','Outstanding','Rate %','EMI','Start date','Payments'],loans.map(l=>[l.name,l.kind,l.principal,l.outstanding,l.interestRate,l.emi,l.startDate.toISOString().slice(0,10),l.payments.length])))});
app.get('/api/exports/payments.csv',async(_req,res)=>{const payments=await db.payment.findMany({include:{loan:true},orderBy:{date:'desc'}});res.type('text/csv').attachment('nivara-payments.csv').send(csv(['Date','Loan','Payment type','Amount'],payments.map(p=>[p.date.toISOString().slice(0,10),p.loan.name,p.kind,p.amount])))});
app.get('/api/backups/latest.json',async(_req,res)=>{const [loans,payments,profiles,documents]=await Promise.all([db.loan.findMany(),db.payment.findMany(),db.financialProfile.findMany(),db.document.findMany({select:{id:true,userId:true,loanId:true,name:true,mimeType:true,sizeBytes:true,createdAt:true}})]);res.attachment('nivara-backup.json').json({version:1,exportedAt:new Date().toISOString(),loans,payments,financialProfiles:profiles,documents});});
app.get('/api/users/:userId/family-shares',async(req,res)=>res.json(await db.familyShare.findMany({where:{ownerId:String(req.params.userId)},include:{recipient:{select:{id:true,name:true,email:true,avatarUrl:true}}},orderBy:{createdAt:'desc'}})));
app.post('/api/users/:userId/family-shares',async(req,res)=>{const data=z.object({email:z.string().email(),role:z.enum(['VIEWER','EDITOR']).default('VIEWER')}).parse(req.body);const recipient=await db.user.findUnique({where:{email:data.email}});const share=await db.familyShare.upsert({where:{ownerId_email:{ownerId:String(req.params.userId),email:data.email}},update:{role:data.role,recipientId:recipient?.id,status:recipient?'ACTIVE':'PENDING'},create:{ownerId:String(req.params.userId),email:data.email,role:data.role,recipientId:recipient?.id,status:recipient?'ACTIVE':'PENDING'}});res.status(201).json(share)});
app.delete('/api/users/:userId/family-shares/:shareId',async(req,res)=>{const share=await db.familyShare.findFirstOrThrow({where:{id:String(req.params.shareId),ownerId:String(req.params.userId)}});await db.familyShare.delete({where:{id:share.id}});res.status(204).end();});
app.post('/api/loans/:id/payments',async(req,res)=>{const p=z.object({amount:z.number().positive(),date:z.coerce.date(),kind:z.enum(['EMI','EXTRA','INTEREST_RENEWAL'])}).parse(req.body);const loan=await db.loan.findUniqueOrThrow({where:{id:req.params.id},include:{payments:true}});const payment=await db.$transaction(async tx=>{const x=await tx.payment.create({data:{...p,loanId:loan.id}});const balance=repaymentProgress(loan.principal,loan.interestRate,[...loan.payments,x]).balance;await tx.loan.update({where:{id:loan.id},data:{outstanding:balance}});return x});res.status(201).json(payment)});
app.delete('/api/loans/:loanId/payments/:paymentId',async(req,res)=>{const loan=await db.loan.findUniqueOrThrow({where:{id:String(req.params.loanId)},include:{payments:true}});const payment=loan.payments.find(x=>x.id===String(req.params.paymentId));if(!payment)return res.status(404).json({message:'Payment not found for this loan.'});await db.$transaction(async tx=>{await tx.payment.delete({where:{id:payment.id}});const balance=repaymentProgress(loan.principal,loan.interestRate,loan.payments.filter(x=>x.id!==payment.id)).balance;await tx.loan.update({where:{id:loan.id},data:{outstanding:balance}})});res.status(204).end()});
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{console.error(err);res.status(400).json({message:err instanceof Error?err.message:'Something went wrong.'})});
app.listen(Number(process.env.PORT||4000),()=>console.log('Nivara API on :4000'));
