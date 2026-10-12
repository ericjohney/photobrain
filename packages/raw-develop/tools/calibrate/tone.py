import numpy as np, sys, glob, os, json
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from paths import FIX, REFS, OUT
from fit import loadf
stems=sorted(os.path.basename(p)[:-4] for p in glob.glob(FIX+'/*.RAF'))
def pair(s):
    L=loadf(f'{REFS}/{s}/default.lin.q.f32'); F=loadf(f'{REFS}/{s}/final.q.f32')
    o=json.load(open(f'{REFS}/{s}/params.json'))['orientation']
    # final has orientation applied; undo to sensor orientation
    return L,F,o
def unrot(F,o):
    return {1:F,8:np.rot90(F,-1),6:np.rot90(F,1),3:np.rot90(F,2)}[o]
def srgb_decode(v):
    v=np.asarray(v); return np.where(v<=0.04045,v/12.92,((v+0.055)/1.055)**2.4)
if __name__=='__main__':
  # Tone samples on near-neutral pixels (diagnostic).
  allx=[];ally=[]
  for s in stems:
    L,F,o=pair(s); F=unrot(F,o)
    if F.shape!=L.shape: print(s,'shape mismatch'); continue
    # neutral-ish pixels: chroma small in linear
    l=L.reshape(-1,3); f=F.reshape(-1,3)
    mx=l.max(1); mn=l.min(1); neutral=(mx-mn)<0.06*mx+1e-4
    Y=l.mean(1); out=srgb_decode(f.mean(1))
    sel=neutral&(Y>1e-4)
    allx.append(Y[sel]); ally.append(out[sel])
    bins=np.array([1/256,1/128,1/64,1/32,1/16,1/8,0.18,1/4,1/2,1,2])
    med=[np.median(out[sel][(Y[sel]>b/1.2)&(Y[sel]<b*1.2)]) if ((Y[sel]>b/1.2)&(Y[sel]<b*1.2)).sum()>20 else np.nan for b in bins]
    print(s,np.round(med,4))
  x=np.concatenate(allx); y=np.concatenate(ally)
  np.save(OUT+'/tone_xy.npy',np.stack([x,y]))
