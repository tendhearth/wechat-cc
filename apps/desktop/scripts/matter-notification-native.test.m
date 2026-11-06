// Offline native boundary test: never requests permission or creates a center.
// clang -fobjc-arc -fblocks -framework Foundation -framework UserNotifications \
//   apps/desktop/scripts/matter-notification-native.test.m -o <temporary>/notification-test
#import "../src-tauri/src/matter_notification.m"
#include <assert.h>
#include <stdio.h>
static int clicks = 0;
static NSString *clickedMatter;
void cc_notification_clicked(const char *matter_id) {
    clicks++;
    clickedMatter = matter_id ? [NSString stringWithUTF8String:matter_id] : nil;
}
@interface CCFixtureNotification : NSObject
@property(nonatomic, strong) UNNotificationRequest *request;
@end
@implementation CCFixtureNotification
@end
@interface CCFixtureResponse : NSObject
@property(nonatomic, strong) NSString *actionIdentifier;
@property(nonatomic, strong) CCFixtureNotification *notification;
@end
@implementation CCFixtureResponse
@end
int main(void) {
    @autoreleasepool {
        CCMatterNotifications *delegate = [CCMatterNotifications new];
        CCFixtureResponse *response = [CCFixtureResponse new];
        response.actionIdentifier = UNNotificationDefaultActionIdentifier;
        response.notification = [CCFixtureNotification new];
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.userInfo = @{ @"matterId": @"deadbeef" };
        response.notification.request = [UNNotificationRequest requestWithIdentifier:@"first" content:content trigger:nil];
        __block int completed = 0;
        [delegate userNotificationCenter:nil didReceiveNotificationResponse:(id)response withCompletionHandler:^{ completed++; }];
        assert(clicks == 1 && [clickedMatter isEqualToString:@"deadbeef"] && completed == 1);
        // Each notification carries its own identity, never the latest global id.
        content.userInfo = @{ @"matterId": @"aaaa1111" };
        response.notification.request = [UNNotificationRequest requestWithIdentifier:@"second" content:content trigger:nil];
        [delegate userNotificationCenter:nil didReceiveNotificationResponse:(id)response withCompletionHandler:^{ completed++; }];
        assert(clicks == 2 && [clickedMatter isEqualToString:@"aaaa1111"] && completed == 2);
        content.userInfo = @{};
        response.notification.request = [UNNotificationRequest requestWithIdentifier:@"legacy" content:content trigger:nil];
        [delegate userNotificationCenter:nil didReceiveNotificationResponse:(id)response withCompletionHandler:^{ completed++; }];
        assert(clicks == 3 && clickedMatter == nil && completed == 3);
        response.actionIdentifier = UNNotificationDismissActionIdentifier;
        [delegate userNotificationCenter:nil didReceiveNotificationResponse:(id)response withCompletionHandler:^{ completed++; }];
        assert(clicks == 3 && completed == 4);
        puts("PASS: exact matter, distinct notifications, missing id, dismissal, completions");
    }
    return 0;
}
