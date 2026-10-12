import os
import numpy as np, sys, warnings, subprocess
warnings.filterwarnings('ignore')
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from paths import FIX, REFS, OUT
from fit import camblocks, appleblocks
from dng import model
from scipy.ndimage import uniform_filter
def data(stem):
    cam,sat=camblocks(stem); app=appleblocks(stem)
    h=min(cam.shape[0],app.shape[0]); w=min(cam.shape[1],app.shape[1]); cam=cam[:h,:w]; app=app[:h,:w]; sat=sat[:h,:w]
    # smoothness: local relative variance of app G small
    g=app[...,1]; mu=uniform_filter(g,5); var=uniform_filter(g*g,5)-mu*mu
    smooth=np.sqrt(np.maximum(var,0))<0.03*mu+1e-4
    m=~sat&smooth&(app.max(-1)<0.85)&(app.min(-1)>0.004)
    c=np.zeros_like(m); c[h//6:5*h//6,w//6:5*w//6]=1; m&=c.astype(bool)
    from paths import meta
    g_,r,b=map(float,meta(stem)['wb'][:3]); neutral=np.array([g_/r,1,g_/b])
    return cam[m],app[m],neutral
if __name__=='__main__':
    for stem in sys.argv[1:]:
        X,Y,neu=data(stem); M,T=model(neu)
        Xw=X/neu  # white balanced camera RGB
        Mfit=np.linalg.lstsq(Xw,Y,rcond=None)[0].T
        pd=X@M.T; g=(pd*Y).sum()/(pd*pd).sum(); pd*=g
        pf=Xw@Mfit.T
        rel=lambda p:np.median(np.abs(p-Y).sum(1)/Y.sum(1))
        print(stem,'n',len(X),'T',round(T),'dng gain log2',round(np.log2(g),3),'err dng',round(rel(pd),4),'err free',round(rel(pf),4))
        print(' free (WB-applied) M:\n',np.round(Mfit,4),'\n dng*gain*diag(neu):\n',np.round(g*M*neu,4))
