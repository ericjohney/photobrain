import numpy as np, sys, glob, os, json, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from paths import FIX, REFS, OUT
from fit import loadf
from tone import unrot, srgb_decode
from scipy.optimize import least_squares
stems=sorted(os.path.basename(p)[:-4] for p in glob.glob(FIX+'/*.RAF'))
L_all=[];F_all=[]
rng=np.random.default_rng(1)
for s in stems:
    L=loadf(f'{REFS}/{s}/default.lin.q.f32'); F=loadf(f'{REFS}/{s}/final.q.f32')
    o=json.load(open(f'{REFS}/{s}/params.json'))['orientation']; F=unrot(F,o)
    l=L.reshape(-1,3); f=F.reshape(-1,3); idx=rng.choice(len(l),40000,replace=False)
    L_all.append(l[idx]); F_all.append(f[idx])
L=np.vstack(L_all); F=np.vstack(F_all)
m=(L.min(1)>-0.002)
L=np.maximum(L[m],0); F=F[m]
KN=np.concatenate([[0],2.0**np.arange(-10,0.01,0.5),[1.5,2,4]])
def curve(x,p):
    # monotone piecewise-linear in log-ish domain on knots KN, values cumulative positive increments
    v=np.concatenate([[0],np.cumsum(np.exp(p))]); return np.interp(x,KN,v,right=v[-1])
p0=np.log(np.diff(np.interp(KN,KN,np.minimum(1,(KN/0.18)**0.45*0.46)))+1e-4)
def per_channel(p): return curve(L,p)
def lum(p):
    Y=L@np.array([0.2290,0.6917,0.0793]); t=curve(Y,p); return L*(t/np.maximum(Y,1e-6))[:,None]
def sat(p):
    t=curve(L,p[:-3]); Y=t@np.array([0.2290,0.6917,0.0793]); k=p[-3]
    return Y[:,None]+(t-Y[:,None])*np.exp(k)
p0=np.concatenate([p0,[0,0,0]]) if False else p0
for name,fn in [('per-channel',per_channel)]:
    sol=least_squares(lambda p:(np.clip(fn(p),0,1)-F).ravel(),p0,loss='soft_l1',f_scale=0.02)
    P=np.clip(fn(sol.x),0,1); err=np.abs(P-F)
    print(name,'mean abs err (encoded)',round(err.mean(),4),'p95',round(np.percentile(err.max(1),95),4))
    print(' curve at knots',np.round(curve(KN,sol.x),4))
    np.save(f'{OUT}/curve_{name}.npy',sol.x)
