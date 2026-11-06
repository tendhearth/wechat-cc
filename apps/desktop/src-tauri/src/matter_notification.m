#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

extern void cc_notification_clicked(const char *matter_id);
@interface CCMatterNotifications : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation CCMatterNotifications
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
      willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    if (@available(macOS 11.0, *)) {
        completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
    } else {
        completion(UNNotificationPresentationOptionAlert);
    }
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completion {
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
        NSString *matter = response.notification.request.content.userInfo[@"matterId"];
        cc_notification_clicked([matter isKindOfClass:NSString.class] ? matter.UTF8String : NULL);
    }
    completion();
}
@end

bool cc_install_notifications(void) {
    if (@available(macOS 10.14, *)) {} else { return false; }
    if (![NSBundle.mainBundle.bundleURL.pathExtension isEqualToString:@"app"]) return false;
    static CCMatterNotifications *delegate;
    if (!delegate) delegate = [CCMatterNotifications new];
    UNUserNotificationCenter.currentNotificationCenter.delegate = delegate;
    return true;
}

void cc_show_notification(const char *title, const char *body, const char *matter_id) {
    @autoreleasepool {
        NSString *noticeTitle = [NSString stringWithUTF8String:title];
        NSString *noticeBody = [NSString stringWithUTF8String:body];
        NSString *matter = matter_id ? [NSString stringWithUTF8String:matter_id] : nil;
        dispatch_async(dispatch_get_main_queue(), ^{
            cc_install_notifications();
            UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
            UNMutableNotificationContent *content = [UNMutableNotificationContent new];
            content.title = noticeTitle;
            content.body = noticeBody;
            if (matter) content.userInfo = @{ @"matterId": matter };
            UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString content:content trigger:nil];
            [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL granted, NSError *error) {
                if (granted) [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
                    if (error) NSLog(@"CC notification: %@", error);
                }];
            }];
        });
    }
}
