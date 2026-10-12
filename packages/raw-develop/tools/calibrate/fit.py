import numpy as np, sys, json
import os, sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from paths import FIX, REFS, OUT, profile
def loadf(p):
    b=open(p,'rb').read(); w,h=np.frombuffer(b[8:16],'<u4'); return np.frombuffer(b[16:],'<f4').reshape(h,w,3)
def camblocks(stem, B=12):
    """Per-channel means of the black-subtracted active area in BxB blocks, scaled so the
    sensor maximum (16383 for 14-bit) is 1.0, plus a near-clip mask."""
    from paths import meta
    m=meta(stem); fw,fh=m['full']; cw,ch=m['crop']; top,left=m['top'],m['left']
    cfa=np.fromfile(f'{REFS}/{stem}/cfa.u16','<u2').reshape(fh,fw).astype(np.float64)
    crop=cfa[top:top+ch,left:left+cw]-m['black']
    pat=np.array(m['pattern'])
    yy=(np.arange(ch)[:,None]+top)%6; xx=(np.arange(cw)[None,:]+left)%6
    P=pat[yy,xx]
    H,W=ch//B*B,cw//B*B; crop=crop[:H,:W]; P=P[:H,:W]
    out=[]
    for c in 'RGB':
        msk=(P==c); s=(crop*msk).reshape(H//B,B,W//B,B).sum((1,3)); n=msk.reshape(H//B,B,W//B,B).sum((1,3))
        out.append(s/n)
    white=profile()['white_level']
    sat=(cfa[top:top+H,left:left+W]>=white*0.985).reshape(H//B,B,W//B,B).any((1,3))
    return np.stack(out,-1)/(16383-m['black']), sat
def appleblocks(stem,name='default.lin.q.f32',B=3):
    a=loadf(f'{REFS}/{stem}/{name}')
    h,w,_=a.shape; return a[:h//B*B,:w//B*B].reshape(h//B,B,w//B,B,3).mean((1,3))
if __name__=='__main__':
    stem=sys.argv[1] if len(sys.argv)>1 else 'DSCF0970'
    cam,sat=camblocks(stem); app=appleblocks(stem)
    h=min(cam.shape[0],app.shape[0]); w=min(cam.shape[1],app.shape[1]); cam=cam[:h,:w]; app=app[:h,:w]; sat=sat[:h,:w]
    # exclude edges (lens warp) and saturated
    mask=~sat; mask[:20]=0;mask[-20:]=0;mask[:,:20]=0;mask[:,-20:]=0
    mask&=(app.max(-1)<0.9)&(cam.min(-1)>0.002)
    X=cam[mask]; Y=app[mask]
    M,res,_,_=np.linalg.lstsq(X,Y,rcond=None)
    pred=X@M
    print(stem,'n',len(X),'M^T=\n',np.round(M.T,4),'\nrel rms',np.sqrt(((pred-Y)**2).mean())/Y.mean())
    np.save(f'{OUT}/M_{stem}.npy',M.T)
