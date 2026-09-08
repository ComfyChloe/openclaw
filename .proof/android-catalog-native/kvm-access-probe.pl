use strict;
use warnings;
use Fcntl qw(O_RDWR);
use JSON::PP;
use POSIX ();

# Linux KVM_GET_API_VERSION is _IO(0xAE, 0x00). No VM or vCPU ioctl is used.
sub error_value { return { errno => 0 + $!, message => "$!" }; }
sub read_metadata {
    my ($path, $pattern) = @_;
    open my $stream, '<', $path or return { error => error_value() };
    local $/;
    my $text = <$stream>;
    close $stream;
    return defined($pattern) ? [grep { /$pattern/ } split /\n/, $text] : $text;
}

my $path = '/dev/kvm';
my @device = stat($path);
my $device_error = @device ? undef : error_value();
my @group = getgrnam('kvm');
my %result = (
    kind => 'read-only KVM access diagnostic; no VM created',
    uid => POSIX::getuid(), effective_uid => POSIX::geteuid(),
    gid => POSIX::getgid(), effective_gid => POSIX::getegid(),
    process_status => read_metadata('/proc/self/status', qr/^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp|Seccomp_filters):/),
    security_context => read_metadata('/proc/self/attr/current', undef),
    uid_map => read_metadata('/proc/self/uid_map', undef),
    gid_map => read_metadata('/proc/self/gid_map', undef),
    cgroup => read_metadata('/proc/self/cgroup', undef),
    kvm_group => @group ? { name => $group[0], gid => $group[2], members => $group[3] } : { absent => JSON::PP::true },
    file_tests => { readable => -r $path ? JSON::PP::true : JSON::PP::false, writable => -w $path ? JSON::PP::true : JSON::PP::false },
    device => @device ? { mode => sprintf('%04o', $device[2] & 07777), uid => $device[4], gid => $device[5], rdev => $device[6] } : { error => $device_error },
);
my $ok = 0;
if (sysopen(my $device, $path, O_RDWR)) {
    $result{open} = { ok => JSON::PP::true };
    my $unused_argument = 0;
    my $version = ioctl($device, 0xAE00, $unused_argument);
    if (defined $version) {
        $result{api_version} = { value => 0 + $version, expected => 12 };
        $ok = (0 + $version == 12);
    } else {
        $result{api_version} = { error => error_value() };
    }
    if (!close($device)) { $result{close} = { error => error_value() }; $ok = 0; }
    else { $result{close} = { ok => JSON::PP::true }; }
} else {
    $result{open} = { ok => JSON::PP::false, error => error_value() };
}
print JSON::PP->new->canonical->pretty->encode(\%result);
exit($ok ? 0 : 1);
