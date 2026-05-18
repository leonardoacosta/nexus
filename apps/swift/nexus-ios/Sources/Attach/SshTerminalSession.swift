// SshTerminalSession — owns the SSH connection that backs SwiftTerm.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.4)
//
// Scaffold: we route bytes between the SSH stream and SwiftTerm. The
// real SSH transport (SwiftNIO-SSH or libssh2) is a follow-on once the
// nexus-mac attach pattern stabilises in NexusShared. Today the
// coordinator implements the SwiftTerm delegate and prints a banner so
// the wiring is exercised end-to-end without a live SSH stack.

import Foundation
import NexusShared
#if canImport(UIKit)
import UIKit
#endif
#if canImport(SwiftTerm)
import SwiftTerm
#endif

#if canImport(SwiftTerm)

@MainActor
final class SshTerminalSession: NSObject, TerminalViewDelegate {
    @Binding var status: AttachStatus

    init(statusBinding: Binding<AttachStatus>) {
        self._status = statusBinding
        super.init()
    }

    // MARK: - Connect / disconnect

    func connect(session: Session, tmuxTarget: String, view: TerminalView) async {
        status = .connecting
        // Render a banner so the user sees something while the real SSH
        // transport is being added. Switching to SwiftNIO-SSH is a
        // follow-up task (bd:nx-gsgvk surfaces the iOS hardware test).
        let banner = """
        nexus-ios attach scaffold
        session  = \(session.id)
        project  = \(session.project ?? "—")
        agent    = \(session.originAgent)
        tmux     = \(tmuxTarget)

        SSH transport not linked. Resolve SwiftNIO-SSH and
        plug the stream into TerminalView.feed(byteArray:).
        """
        for line in banner.split(separator: "\n") {
            view.feed(text: String(line) + "\r\n")
        }
        status = .connected
    }

    // MARK: - TerminalViewDelegate

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        // No-op until the SSH writer lands. Captured here so the keyboard
        // path is wired even without a transport.
    }

    func scrolled(source: TerminalView, position: Double) {}
    func setTerminalTitle(source: TerminalView, title: String) {}
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func requestOpenLink(source: TerminalView, link: String, params: [String : String]) {}
    func clipboardCopy(source: TerminalView, content: Data) {}
    func bell(source: TerminalView) {}
}

#endif
