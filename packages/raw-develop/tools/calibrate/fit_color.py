# Same joint fit as fit4, but colour = C(T) @ XYZD50->P3 @ ForwardMatrix(T) @ diag(1/neutral):
# DNG camera colour (Adobe ForwardMatrix data) followed by a fitted white-preserving 3x3 in linear P3.
import numpy as np, json, sys, os
import os, sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from paths import FIX, REFS, OUT, profile
sys.argv=['x']
exec(open(os.path.join(os.path.dirname(__file__),'fit4.py')).read().split("def w_of")[0])
from dng import FM1, FM2, XYZD50_to_P3
BLACK_RENDER=profile().get('black_render',0.003)
def w_of(T):
    T=min(max(T,2856),6504); return (1/T-1/6504)/(1/2856-1/6504)
def mats(p):
    out=[]
    for q in (p[:6],p[6:12]):
        M=np.zeros((3,3)); M[:,:2]=q.reshape(3,2); M[:,2]=1-M[:,:2].sum(1); out.append(M)
    return out
def model(p,T):
    w=w_of(T); CA,CD=mats(p); C=w*CA+(1-w)*CD; FM=w*FM1+(1-w)*FM2
    return C@XYZD50_to_P3@FM
def resid(p):
    r=[]
    for s,Xw,Y,reb,T in D:
        P=2**(p[12]-reb)*(Xw@model(p,T).T-BLACK_RENDER)
        r.append(((P-Y)/(Y.sum(1,keepdims=True)/3+0.01)).ravel())
    return np.concatenate(r)
I=np.eye(3); p0=np.concatenate([I[:,:2].ravel(),I[:,:2].ravel(),[-0.5]])
sol=least_squares(resid,p0,loss='soft_l1',f_scale=0.05)
CA,CD=mats(sol.x)
print('bexp',round(sol.x[12],4)); print('CA',np.round(CA,4).tolist()); print('CD',np.round(CD,4).tolist())
for s,Xw,Y,reb,T in D:
    P=2**(sol.x[12]-reb)*(Xw@model(sol.x,T).T-BLACK_RENDER)
    print(s,'T',round(T),'median rel err',round(np.median(np.abs(P-Y).sum(1)/Y.sum(1)),4))
json.dump({'bexp':sol.x[12],'CA':CA.tolist(),'CD':CD.tolist()},open(OUT+'/colorfit3.json','w'),indent=1)
