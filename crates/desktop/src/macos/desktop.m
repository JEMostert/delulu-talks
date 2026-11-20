#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <ApplicationServices/ApplicationServices.h>

// Carbon reserves only the selected shortcut and delivers both edges, even
// while another application owns keyboard focus. AppKit state lives on main.
typedef void (*Edge)(bool);
static EventHotKeyRef binding;
static EventHandlerRef handler;
static Edge edge;
static const UInt32 keys[] = {kVK_Space, kVK_ANSI_D, kVK_ANSI_Z};
static const UInt32 modifiers[] = {controlKey | shiftKey, controlKey | optionKey, controlKey | shiftKey};
static NSArray<NSString *> *names(void) {
    return @[@"Control+Shift+Space", @"Control+Option+D", @"Control+Shift+Z"];
}
static void onMain(dispatch_block_t work) {
    if (NSThread.isMainThread) work();
    else dispatch_sync(dispatch_get_main_queue(), work);
}
static OSStatus receive(EventHandlerCallRef next, EventRef event, void *context) {
    (void)next;
    (void)context;
    EventHotKeyID id;
    if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL,
        sizeof(id), NULL, &id) || id.signature != 'DlTk') return eventNotHandledErr;
    if (edge) edge(GetEventKind(event) == kEventHotKeyPressed);
    return noErr;
}
static int selected(void) {
    NSInteger index = [NSUserDefaults.standardUserDefaults integerForKey:@"talkKey"];
    return index >= 0 && (NSUInteger)index < names().count ? (int)index : 0;
}
static bool install(int index) {
    CFArrayRef shortcuts = NULL;
    if (CopySymbolicHotKeys(&shortcuts) == noErr) {
        for (NSDictionary *key in CFBridgingRelease(shortcuts)) {
            if ([key[(__bridge NSString *)kHISymbolicHotKeyEnabled] boolValue] &&
                [key[(__bridge NSString *)kHISymbolicHotKeyCode] unsignedIntValue] == keys[index] &&
                [key[(__bridge NSString *)kHISymbolicHotKeyModifiers] unsignedIntValue] == modifiers[index]) return false;
        }
    }
    EventHotKeyID id = {'DlTk', 1};
    EventHotKeyRef replacement;
    if (RegisterEventHotKey(keys[index], modifiers[index], id, GetApplicationEventTarget(),
                            0, &replacement) != noErr) return false;
    if (binding) UnregisterEventHotKey(binding);
    binding = replacement;
    return true;
}
int delulu_bind(Edge callback) {
    __block int index = -1;
    onMain(^{
        EventTypeSpec events[] = {{kEventClassKeyboard,kEventHotKeyPressed},
                                  {kEventClassKeyboard,kEventHotKeyReleased}};
        if (!handler && InstallApplicationEventHandler(receive, 2, events, NULL, &handler)) return;
        edge = callback;
        if (install(selected())) index = selected();
    });
    return index;
}
int delulu_configure(void) {
    __block int index = -1;
    onMain(^{
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Dictation shortcut";
        NSPopUpButton *menu = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(0,0,240,28) pullsDown:NO];
        [menu addItemsWithTitles:names()];
        [menu selectItemAtIndex:selected()];
        alert.accessoryView = menu;
        [alert addButtonWithTitle:@"Save"];
        [alert addButtonWithTitle:@"Cancel"];
        if ([alert runModal] != NSAlertFirstButtonReturn) { index = binding ? selected() : -1; return; }
        int choice = (int)menu.indexOfSelectedItem;
        if ((binding && choice == selected()) || install(choice)) {
            [NSUserDefaults.standardUserDefaults setInteger:choice forKey:@"talkKey"];
            index = choice;
        }
    });
    return index;
}
void delulu_unbind(void) {
    onMain(^{
        if (binding) UnregisterEventHotKey(binding);
        if (handler) RemoveEventHandler(handler);
        binding = NULL; handler = NULL; edge = NULL;
    });
}
bool delulu_can_paste(bool prompt) {
    return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{
        (__bridge NSString *)kAXTrustedCheckOptionPrompt: @(prompt)
    });
}
bool delulu_paste(void) {
    if (!delulu_can_paste(false)) return false;
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, kVK_ANSI_V, true);
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, kVK_ANSI_V, false);
    if (down && up) {
        CGEventSetFlags(down,kCGEventFlagMaskCommand);
        CGEventSetFlags(up,kCGEventFlagMaskCommand);
        CGEventPost(kCGHIDEventTap,down);
        CGEventPost(kCGHIDEventTap,up);
    }
    bool ok = down && up;
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    return ok;
}
