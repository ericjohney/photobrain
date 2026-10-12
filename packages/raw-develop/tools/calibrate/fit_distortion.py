import os
import numpy as np, sys, warnings, subprocess
warnings.filterwarnings('ignore')
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from paths import FIX, REFS, OUT
from fit import loadf
from scipy.ndimage import map_coordinates, gaussian_filter
from scipy.optimize import minimize
stem=sys.argv[1]
def prep(n):
    a=loadf(f'{REFS}/{stem}/{n}.lin.q.f32')[...,1]; a=np.log(np.maximum(a,0)+1e-3)
    return a-gaussian_filter(a,8)   # high-pass: removes vignetting/shading
A=prep('nolens'); B=prep('default')
h,w=A.shape; cy,cx=h/2,w/2; R=np.hypot(cx,cy)
yy,xx=np.mgrid[0:h,0:w]+0.5; r=np.hypot(xx-cx,yy-cy)/R
vals=list(map(float,subprocess.run(['exiftool','-s3','-GeometricDistortionParams',f'{FIX}/{stem}.RAF'],capture_output=True,text=True).stdout.split()))
kn=np.array(vals[1:10]); fd=np.array(vals[10:19])
m=np.zeros_like(A,bool); m[30:-30,30:-30]=1
def warp(dv,mode):
    s=1+np.interp(r,np.concatenate([[0],kn]),np.concatenate([[0],dv]))/100
    if mode=='inv': s=1/s
    return map_coordinates(A,[cy+(yy-cy)*s-0.5,cx+(xx-cx)*s-0.5],order=1,mode='nearest')
f=lambda dv,mode='fwd': ((warp(dv,mode)-B)[m]**2).mean()
print('identity',round(f(np.zeros(9)),6),'fuji',round(f(fd),6),'fuji inv',round(f(fd,'inv'),6))
sol=minimize(f,fd,method='Powell',options=dict(xtol=1e-3,ftol=1e-10,maxfev=4000))
print('free fit',round(sol.fun,6)); print(' knots',np.round(kn,3)); print(' fuji ',np.round(fd,3)); print(' fit  ',np.round(sol.x,3))
g=lambda k: f(fd+k[0])
s2=minimize(g,[1.0],method='Nelder-Mead'); print('fuji+const k',np.round(s2.x,4),'mse',round(s2.fun,6))
gs=lambda k: ((map_coordinates(A,[cy+(yy-cy)*(1+np.interp(r,np.concatenate([[0],kn]),np.concatenate([[0],fd]))/100)*k[0]-0.5,cx+(xx-cx)*(1+np.interp(r,np.concatenate([[0],kn]),np.concatenate([[0],fd]))/100)*k[0]-0.5],order=1,mode='nearest')-B)[m]**2).mean()
s3=minimize(gs,[1.01],method='Nelder-Mead'); print('fuji*scale',np.round(s3.x,5),'mse',round(s3.fun,6))
