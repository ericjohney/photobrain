import os
import numpy as np, sys, subprocess, json
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from paths import FIX, REFS, OUT
from paths import profile
_p=profile()
CM1=np.array(_p['color_matrix_1']).reshape(3,3)    # calibration illuminant 1 (StdA 2856 K)
CM2=np.array(_p['color_matrix_2']).reshape(3,3)    # calibration illuminant 2 (D65)
FM1=np.array(_p['forward_matrix_1']).reshape(3,3)
FM2=np.array(_p['forward_matrix_2']).reshape(3,3)
# XYZ(D50) -> linear Display P3 (D65), Bradford
P3_to_XYZD65=np.array([[0.48657,0.26567,0.19822],[0.22897,0.69174,0.07929],[0,0.04511,1.04394]])
brad=np.array([[0.9555766,-0.0230393,0.0631636],[-0.0282895,1.0099416,0.0210077],[0.0122982,-0.0204830,1.3299098]]) # D50->D65
XYZD50_to_P3=np.linalg.inv(P3_to_XYZD65)@brad
def xy_to_cct(x,y):
    n=(x-0.3320)/(0.1858-y); return 449*n**3+3525*n**2+6823.3*n+5520.33
def interp(T,A,B):
    if T<=2856: return A
    if T>=6504: return B
    w=(1/T-1/6504)/(1/2856-1/6504); return w*A+(1-w)*B
def neutral_to_cct(neutral):
    T=5000
    for _ in range(30):
        CM=interp(T,CM1,CM2); XYZ=np.linalg.solve(CM,neutral); x,y=XYZ[:2]/XYZ.sum(); T=xy_to_cct(x,y)
    return T
def model(neutral):
    T=neutral_to_cct(neutral); FM=interp(T,FM1,FM2)
    return XYZD50_to_P3@FM@np.diag(1/neutral), T
if __name__=='__main__':
    from fit import camblocks, appleblocks
    for stem in sys.argv[1:]:
        lv=subprocess.run(['exiftool','-s3','-WB_GRBLevels',f'{FIX}/{stem}.RAF'],capture_output=True,text=True).stdout.split()
        g,r,b=map(float,lv); neutral=np.array([g/r,1,g/b])
        M,T=model(neutral)
        cam,sat=camblocks(stem); app=appleblocks(stem)
        h=min(cam.shape[0],app.shape[0]); w=min(cam.shape[1],app.shape[1]); cam=cam[:h,:w]; app=app[:h,:w]; sat=sat[:h,:w]
        m=~sat; c=np.zeros_like(m); c[h//4:3*h//4,w//4:3*w//4]=1; m&=c.astype(bool)&(app.max(-1)<0.9)&(app.min(-1)>0.003)
        pred=cam[m]@M.T; Y=app[m]
        gain=(pred*Y).sum()/(pred*pred).sum()
        err=np.abs(gain*pred-Y)/np.maximum(Y,1e-3)
        Mfit=np.linalg.lstsq(cam[m],Y,rcond=None)[0].T
        print(stem,'T',round(T),'gain',round(gain,4),'log2',round(np.log2(gain),3),'median rel err',np.round(np.median(err,0),4),'fit/dng ratio\n',np.round(Mfit/(gain*M),3))
