# Joint fit: P3lin = 2^(bexp - reb) * Mw(T) @ diag(1/neutral) @ raw_norm,  Mw rows sum to 1,
# Mw(T) interpolated in 1/T between two fitted matrices (A at 2856K, D65 at 6504K) like DNG.
import numpy as np, sys, warnings, io, contextlib, glob, os, subprocess, json
warnings.filterwarnings('ignore')
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from paths import FIX, REFS, OUT
with contextlib.redirect_stdout(io.StringIO()):
    from fit2 import data
from dng import neutral_to_cct
from scipy.optimize import least_squares
from paths import meta, profile
WHITE=profile()['white_level']
stems=sorted(os.path.basename(p)[:-4] for p in glob.glob(FIX+'/*.RAF'))
D=[]
for s in stems:
    X,Y,neu=data(s)
    if len(X)<500: print('skip',s,len(X)); continue
    BLACK=meta(s)['black']
    X=X*(16383-BLACK)/(WHITE-BLACK)
    reb=meta(s)['reb']
    T=neutral_to_cct(neu)
    idx=np.random.default_rng(0).choice(len(X),min(len(X),8000),replace=False)
    D.append((s,X[idx]/neu,Y[idx],reb,T))
def w_of(T):
    T=min(max(T,2856),6504); return (1/T-1/6504)/(1/2856-1/6504)
def mats(p):
    out=[]
    for q in (p[:6],p[6:12]):
        M=np.zeros((3,3)); M[:,:2]=q.reshape(3,2); M[:,2]=1-M[:,:2].sum(1); out.append(M)
    return out
def resid(p,bexp=None):
    MA,MD=mats(p); b=p[12]; r=[]
    for s,Xw,Y,reb,T in D:
        w=w_of(T); M=w*MA+(1-w)*MD
        P=2**(b-reb)*Xw@M.T
        r.append(((P-Y)/(Y.sum(1,keepdims=True)/3+0.01)).ravel())
    return np.concatenate(r)
I=np.eye(3)
p0=np.concatenate([I[:,:2].ravel(),I[:,:2].ravel(),[-0.5]])
sol=least_squares(resid,p0,loss='soft_l1',f_scale=0.05)
MA,MD=mats(sol.x)
print('bexp',round(sol.x[12],4)); print('MA\n',np.round(MA,4)); print('MD\n',np.round(MD,4))
for s,Xw,Y,reb,T in D:
    w=w_of(T); P=2**(sol.x[12]-reb)*Xw@(w*MA+(1-w)*MD).T
    print(s,'T',round(T),'median rel err',round(np.median(np.abs(P-Y).sum(1)/Y.sum(1)),4))
json.dump({'bexp':sol.x[12],'MA':MA.tolist(),'MD':MD.tolist()},open(OUT+'/colorfit.json','w'),indent=1)
