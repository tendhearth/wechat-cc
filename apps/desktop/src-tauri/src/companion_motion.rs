//! Bounded temporary placement: local animation never adopts a user's anchor.
use crate::companion_placement::{self, Layout, Placement, Screen};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct MotionContext { pub token:u64, pub min_offset:f64, pub max_offset:f64 }

#[derive(Default)]
pub(crate) struct MotionSession {
    epoch:u64, active:bool, temporary:bool,
    anchor:Option<Layout>, screen:Option<Screen>, bounds:Option<MotionContext>,
}
impl MotionSession {
    pub fn begin(&mut self,screen:&Screen,layout:&Layout)->Option<MotionContext> {
        self.stop();
        let placement=companion_placement::capture(screen,layout,true,false)?;
        if !layout.scale.is_finite()||(screen.scale-layout.scale).abs()>1e-6 {return None}
        let gap=(screen.y+screen.height-layout.y-layout.height*screen.scale)/screen.scale;
        let left=(layout.x-screen.x)/screen.scale;
        let right=screen.width/screen.scale-layout.width-left;
        if !(0.0..=64.0).contains(&gap)||left<0.0||right<0.0||placement.width!=layout.width {return None}
        let bounds=MotionContext {token:self.epoch,min_offset:(-48.0_f64).max(-left),max_offset:48.0_f64.min(right)};
        self.anchor=Some(layout.clone());self.screen=Some(screen.clone());self.bounds=Some(bounds.clone());
        self.temporary=true;self.active=true;Some(bounds)
    }
    pub fn step(&mut self,token:u64,offset:f64,screen:&Screen,visible:bool)->Option<Layout> {
        let bounds=self.bounds.as_ref()?;
        if !self.active||token!=self.epoch||!visible||self.screen.as_ref()!=Some(screen)||!offset.is_finite()
            ||offset<bounds.min_offset||offset>bounds.max_offset {return None}
        let anchor=self.anchor.as_ref()?;
        Some(Layout {x:anchor.x+offset*anchor.scale,..anchor.clone()})
    }
    pub fn stop(&mut self){self.epoch=self.epoch.wrapping_add(1).max(1);self.active=false}
    pub fn temporary(&self)->bool {self.temporary}
    pub fn anchor(&self)->Option<&Layout> {self.anchor.as_ref()}
    pub fn saved(&self)->Option<Placement> {companion_placement::capture(self.screen.as_ref()?,self.anchor.as_ref()?,true,false)}
    /// Native size changes are user intent, while the walk offset is not.
    /// Keep the original anchor (clamped for the new size), not the temporary x.
    pub fn resize_anchor(&mut self,screen:&Screen,observed:&Layout,macos:bool)->Option<Layout> {
        let anchor=self.anchor.as_ref()?;
        if !self.temporary||self.screen.as_ref()!=Some(screen)
            ||(anchor.width-observed.width).abs()<0.5&&(anchor.height-observed.height).abs()<0.5 {return None}
        let updated=Layout {width:observed.width,height:observed.height,..anchor.clone()};
        let saved=companion_placement::capture(screen,&updated,true,false)?;
        let updated=companion_placement::restore(Some(&saved),&[screen.clone()],0,macos)?;
        self.stop();self.anchor=Some(updated.clone());Some(updated)
    }
    pub fn adopt(&mut self){self.stop();self.temporary=false;self.anchor=None;self.screen=None;self.bounds=None}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion_placement::{Layout, Screen};
    fn screen() -> Screen { Screen { name:Some("test".into()),x:-2880.0,y:0.0,width:2880.0,height:1800.0,scale:2.0 } }
    fn layout() -> Layout { Layout { scale:2.0,x:-900.0,y:1168.0,width:240.0,height:300.0 } }
    #[test]
    fn bottom_bounds_are_logical_and_never_cross_a_negative_origin_monitor() {
        let mut session=MotionSession::default();
        let context=session.begin(&screen(),&layout()).unwrap();
        assert_eq!((context.min_offset,context.max_offset),(-48.0,48.0));
        let moved=session.step(context.token,48.0,&screen(),true).unwrap();
        assert_eq!((moved.x,moved.y),(-804.0,1168.0));
        assert!(session.step(context.token,49.0,&screen(),true).is_none());
        assert!(session.step(context.token,f64::NAN,&screen(),true).is_none());
        let edge=Layout { x:-500.0,..layout() };
        let context=session.begin(&screen(),&edge).unwrap();
        assert!(context.max_offset<=10.0);
    }
    #[test]
    fn stop_rejects_old_steps_but_keeps_temporary_placement_protected_until_adoption() {
        let mut session=MotionSession::default();let c=session.begin(&screen(),&layout()).unwrap();
        session.step(c.token,-24.0,&screen(),true).unwrap();session.stop();
        assert!(session.temporary());assert!(session.step(c.token,0.0,&screen(),true).is_none());
        assert_eq!(session.anchor().unwrap(),&layout());
        session.adopt();assert!(!session.temporary());
        assert!(session.step(c.token,1.0,&screen(),true).is_none());
    }
    #[test]
    fn invisible_changed_display_and_mid_screen_never_move() {
        let mut session=MotionSession::default();let c=session.begin(&screen(),&layout()).unwrap();
        assert!(session.step(c.token,5.0,&screen(),false).is_none());
        assert!(session.step(c.token,5.0,&Screen { scale:1.0,..screen() },true).is_none());
        assert!(session.begin(&screen(),&Layout { y:300.0,..layout() }).is_none());
        assert!(session.begin(&Screen { width:100.0,..screen() },&layout()).is_none());
    }
    #[test]
    fn native_resize_after_or_during_a_stroll_retains_size_without_adopting_its_offset() {
        for stop_first in [false,true] {
            let mut s=MotionSession::default();let c=s.begin(&screen(),&layout()).unwrap();
            let mut observed=s.step(c.token,-24.0,&screen(),true).unwrap();
            if stop_first {s.stop()}
            observed.width=260.0;observed.height=325.0;
            let updated=s.resize_anchor(&screen(),&observed,true).unwrap();
            assert_eq!(updated.x,layout().x);assert_eq!((updated.width,updated.height),(260.0,325.0));
            assert!(updated.y+updated.height*updated.scale<=screen().y+screen().height);
            assert!(s.step(c.token,0.0,&screen(),true).is_none());assert!(s.temporary());
            assert_eq!(s.saved().unwrap().width,260.0);
            assert!(s.resize_anchor(&screen(),&updated,true).is_none());
        }
    }
}
