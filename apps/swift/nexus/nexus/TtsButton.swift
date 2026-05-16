//
//  TtsButton.swift
//  nexus
//
//  Waveform glyph + popover with mute / switch provider / test voice. All
//  state changes patch `/notifications/settings` so the bash listener picks
//  them up too.
//

import SwiftUI

struct TtsButton: View {
    @EnvironmentObject private var vm: NexusViewModel
    @State private var showPopover = false

    var body: some View {
        Button {
            showPopover.toggle()
        } label: {
            VStack(spacing: 4) {
                Image(systemName: vm.ttsEnabled ? "waveform" : "speaker.slash")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(vm.ttsEnabled ? Color.nx.ink2 : Color.nx.ink4)
                Text("TTS")
                    .font(.jbm(9, weight: .medium))
                    .tracking(1.4)
                    .foregroundStyle(Color.nx.ink3)
            }
        }
        .buttonStyle(.plain)
        .modifier(ActionButtonStyle())
        .popover(isPresented: $showPopover, arrowEdge: .top) {
            TtsPopover().environmentObject(vm)
        }
    }
}

struct TtsPopover: View {
    @EnvironmentObject private var vm: NexusViewModel
    @State private var testing = false

    var body: some View {
        VStack(spacing: 0) {
            header
            row(icon: vm.ttsEnabled ? "speaker.slash" : "speaker.wave.2",
                label: vm.ttsEnabled ? "Mute" : "Unmute",
                kbd: "⌘M") {
                Task { await vm.toggleTtsMute() }
            }
            row(icon: "arrow.triangle.2.circlepath",
                label: "Switch to local say()",
                kbd: nil) {
                Task { await vm.switchTtsProvider("say") }
            }
            row(icon: "play.circle",
                label: "Test voice",
                kbd: "⌘T") {
                testing = true
                Task {
                    await vm.testVoice()
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    testing = false
                }
            }
            if testing { waveform }
        }
        .frame(width: 280)
        .background(Color.nx.substrate3)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(vm.ttsEnabled ? Color.nx.phosphor : Color.nx.ink4)
                .frame(width: 8, height: 8)
                .shadow(color: vm.ttsEnabled ? Color.nx.phosphor.opacity(0.6) : .clear, radius: 4)
            Text(vm.ttsEnabled ? "via elevenlabs" : "muted")
                .font(.jbm(11))
            Spacer()
            Text("AUDIO").font(.jbm(9)).tracking(1.6).foregroundStyle(Color.nx.ink3)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .overlay(Rectangle().fill(Color.nx.hairline).frame(height: 1), alignment: .bottom)
    }

    @ViewBuilder
    private func row(icon: String, label: String, kbd: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.nx.phosphor)
                    .frame(width: 14, height: 14)
                Text(label)
                    .font(.jbm(11))
                    .foregroundStyle(Color.nx.ink)
                Spacer()
                if let kbd = kbd {
                    Text(kbd)
                        .font(.jbm(9))
                        .foregroundStyle(Color.nx.ink3)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: 2).stroke(Color.nx.hairlineStrong, lineWidth: 1))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
        .overlay(Rectangle().fill(Color.nx.hairline).frame(height: 1), alignment: .bottom)
        .contentShape(Rectangle())
    }

    private var waveform: some View {
        TimelineView(.animation) { timeline in
            Canvas { ctx, size in
                let t = timeline.date.timeIntervalSinceReferenceDate
                var path = Path()
                let mid = size.height / 2
                let step: CGFloat = 2
                for x in stride(from: 0, through: size.width, by: step) {
                    let phase = Double(x) * 0.18 + t * 4
                    let amp = 8 + sin(t * 2) * 2
                    let y = mid + CGFloat(sin(phase)) * CGFloat(amp)
                    if x == 0 { path.move(to: CGPoint(x: x, y: y)) }
                    else      { path.addLine(to: CGPoint(x: x, y: y)) }
                }
                ctx.stroke(path, with: .color(Color.nx.phosphor), lineWidth: 1.2)
            }
        }
        .frame(height: 24)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.nx.phosphor.opacity(0.04))
    }
}
